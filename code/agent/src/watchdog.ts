import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './types.js';
import type { Channel } from './channel.js';
import { Store } from './store.js';
import { atomicJson, jsonFile, post } from './util.js';
import { ChannelDeadlineError, DeliveryUncertain, withDeadline } from './channel-http.js';

type Fault = 'heartbeat' | 'input' | 'model' | 'feishu' | 'disk';
interface Alert { active: boolean; epoch: number; messageId?: string; localEpoch?: number; remoteEpoch?: number; recoveryLocal?: number; recoveryRemote?: number; uncertainRemoteKey?: string }
type State = Partial<Record<Fault, Alert>>;
const descriptions: Record<Fault, { title: string; text: string }> = {
  heartbeat: { title: '个人助手停了', text: '个人助手很久没有报平安，可能已经停了。新输入可能暂时接不住；请回电脑检查常驻进程，自动拉起后会报恢复。' },
  input: { title: '输入卡住了', text: '有一条输入很久没处理完，后面的输入可能也在等。请检查网络和模型连接；不要反复发送，已收到的输入仍保留。' },
  model: { title: '个人助手暂时答不上', text: '模型接口已连续失败，暂时不能理解输入。请检查网络、额度和模型配置；不会自动重试失败的输入。' },
  feishu: { title: '飞书连接断了', text: '个人助手很久没有连上飞书，可能收不到新消息或发不出回复。请检查网络和机器人配置，连接恢复后会再通知。' },
  disk: { title: '电脑空间快不够了', text: '剩余磁盘空间低于设定底线，保存输入和进度可能失败。请在电脑上清出空间；助手不会替你删除文件。' },
};
export class Watchdog {
  private state: State = {};
  private store?: Store;
  private timer?: NodeJS.Timeout;
  private work: Promise<void> = Promise.resolve();
  private started = Date.now();
  private stopped = false;
  private readonly stopping = new AbortController();
  constructor(readonly c: Config, readonly channel: Channel, readonly diskFree?: () => Promise<number>) {}
  async start() {
    this.state = await jsonFile<State>(join(this.c.dataDir, 'watchdog-state.json')).catch(() => ({}));
    this.work = this.tick(); await this.work;
    if (!this.stopped) this.timer = setInterval(() => { this.work = this.work.then(() => this.tick()).catch(() => {}); }, this.c.watchdog.pollMs);
  }
  async tick(now = Date.now()) {
    if (this.stopped) return;
    const heartbeat = await jsonFile<{ at: number }>(join(this.c.dataDir, 'heartbeat.json')).catch(() => undefined);
    const conditions: Partial<Record<Fault, boolean>> = { heartbeat: now - (heartbeat?.at ?? this.started) > this.c.watchdog.heartbeatStaleMs };
    try {
      this.store ??= new Store(this.c, true);
      const oldest = this.store.oldest();
      conditions.input = !!oldest && now - oldest.created > this.c.watchdog.inputStaleMs;
      conditions.model = this.store.get('modelFailures', 0) >= this.c.watchdog.modelFailures;
      const disconnected = this.store.get<number | null>('feishuDisconnectedAt', null);
      conditions.feishu = disconnected !== null && now - disconnected > this.c.watchdog.feishuStaleMs;
    } catch { /* Unknown is not recovery. Never open the main database writable. */ }
    try {
      const bytes = this.diskFree ? await this.diskFree() : await statfs(this.c.dataDir).catch(() => statfs(dirname(this.c.dataDir))).then(s => s.bavail * s.bsize);
      conditions.disk = bytes < this.c.watchdog.minDiskBytes;
    } catch { /* A failed disk query cannot dismiss an existing alert. */ }
    for (const [fault, bad] of Object.entries(conditions) as [Fault, boolean][]) await this.transition(fault, bad);
  }
  private async persist() {
    // Low/full disk must not prevent the very notification that asks for space.
    await atomicJson(join(this.c.dataDir, 'watchdog-state.json'), this.state).catch(() => {});
  }
  private async transition(fault: Fault, bad: boolean) {
    if (this.stopped) return;
    let a = this.state[fault];
    if (!a && !bad) return;
    a ??= { active: false, epoch: 0 }; this.state[fault] = a;
    if (bad && !a.active) { a.active = true; a.epoch++; await this.persist(); }
    if (!bad && a.active) { a.active = false; await this.persist(); }
    const desc = descriptions[fault];
    const title = bad ? desc.title : `${desc.title.replace(/停了|断了|卡住了|暂时答不上|快不够了/, '')}已恢复`;
    const text = bad ? desc.text : `已恢复：${desc.title}这项故障已解除。其他故障会各自核实，不代表未完成的输入已完成。无需重复操作。`;
    const kind = bad ? 'fault' : 'recovery', key = `watchdog:${fault}:${kind}:${a.epoch}`;
    const localKey = bad ? 'localEpoch' : 'recoveryLocal';
    const remoteKey = bad ? 'remoteEpoch' : 'recoveryRemote';
    if (a[localKey] !== a.epoch) {
      try {
        await withDeadline(this.c.feishu.timeoutMs, this.stopping.signal, signal => this.local({ id: `watchdog:${fault}`, key, action: bad && a.epoch > 1 ? 'update' : 'send', title, text, fault, state: kind }, signal));
        a[localKey] = a.epoch; await this.persist();
      } catch { /* Retry only this unsent destination, using the same dedupe key. */ }
    }
    if (a[remoteKey] !== a.epoch && a.uncertainRemoteKey !== key) {
      try {
        await withDeadline(this.c.feishu.timeoutMs, this.stopping.signal, async signal => {
          if (bad && a.messageId) await this.channel.update(a.messageId, `${title}\n${text}`, signal);
          else { const id = await this.channel.send(`${title}\n${text}`, key, signal); if (bad) a.messageId = id; }
        });
        a[remoteKey] = a.epoch; await this.persist();
      } catch (error) {
        if (error instanceof DeliveryUncertain || error instanceof ChannelDeadlineError || this.stopping.signal.aborted) {
          a.uncertainRemoteKey = key; await this.persist(); // A timed-out send may have arrived: never resend it.
        }
        // Known unsent failures may retry; no single destination blocks other faults/recovery.
      }
    }
  }
  private async local(data: { title: string; text: string; [key: string]: unknown }, signal: AbortSignal) {
    if (this.c.watchdog.local.mode === 'fake') { await post(`${this.c.watchdog.local.url}/notify`, data, this.c.feishu.timeoutMs, signal); return; }
    if (process.platform !== 'darwin') throw new Error('本机通知只支持 macOS；测试请使用替身');
    const script = `ObjC.import('Foundation'); ObjC.import('AppKit');
function run(argv) {
  const center = $.NSUserNotificationCenter.defaultUserNotificationCenter;
  const delivered = center.deliveredNotifications;
  for (let i = 0; i < delivered.count; i++) {
    const old = delivered.objectAtIndex(i);
    if (ObjC.unwrap(old.identifier) === argv[0]) center.removeDeliveredNotification(old);
  }
  const note = $.NSUserNotification.alloc.init;
  note.identifier = argv[0]; note.title = argv[1]; note.informativeText = argv[2];
  center.deliverNotification(note);
}`;
    await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(data.state === 'recovery' ? data.key : data.id), data.title, data.text], { timeout: this.c.feishu.timeoutMs, signal, killSignal: 'SIGKILL' });
  }
  async stop() { if (this.stopped) return; this.stopped = true; clearInterval(this.timer); this.stopping.abort(new Error('看门狗已停止')); await this.work; this.store?.close(); }
}
