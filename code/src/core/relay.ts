import { join } from 'node:path';
import { isRedline } from './action-items.ts';
import { assertRelayIdle, readRelayTranscript, relayFailureReason, relayTarget, RelayFailure, resumeCC } from './cc-relay.ts';
import type { RelayTarget } from './cc-relay.ts';
import { recoverDeadLock, withNamedLock } from './locks.ts';
import { appendJsonl, readJsonl } from './store.ts';
import { hash } from './utils.ts';
import type { Config, Notice } from './types.ts';

export const RELAY_INPUT_LIMIT = 4000;
export const WINDOW_WARNING = '窗口里看不到这一轮，回电脑后先重开这个会话再接着聊。';
export interface RelayDraft {
  id: string; text: string; target: RelayTarget; redline: boolean; redlineConfirmed: boolean;
}
export interface RelayView {
  stage: 'entry' | 'input' | 'preview' | 'stale' | 'redline' | 'sending' | 'done';
  draft?: RelayDraft; target?: RelayTarget; suggestion?: string; message?: string;
}
interface CardRow { type: 'card'; id: string; at: string; target?: RelayTarget; suggestion?: string; redline: boolean; failure?: string }
interface Attempt { id: string; at: string; actor: string; noticeId: string; messageId: string; text: string; target: RelayTarget; ownerPid: number; draft: RelayDraft }
interface ActionRow { type: 'action'; id: string; at: string; noticeId: string; messageId: string; consumed?: string; view: RelayView; attempt?: Attempt }
interface ResultRow { type: 'result'; id: string; at: string; attemptId: string; actor: string; sessionId: string; text: string; outcome: 'sent' | 'failed' | 'changed'; noticeId: string; messageId: string; view: RelayView }
type ViewRow = ActionRow | ResultRow;
type Row = CardRow | ViewRow | { type: 'started'; id: string; at: string } | { type: 'ui_done'; id: string; at: string; ok: boolean };
export interface RelayInput { id: string; at: string; actor: string; messageId: string; value?: Record<string, string>; relayText?: string }
const at = () => new Date().toISOString();
const done = (message: string): RelayView => ({ stage: 'done', message });
function suggestion(notice: Notice): string | undefined {
  return (notice.content.actionItems ?? notice.snapshot?.actionItems ?? [])
    .filter(item => item.label === '回复会话' && typeof item.suggestion === 'string' && !!item.suggestion.trim() && !isRedline(`${item.text}\n${item.suggestion}`))
    .map(item => item.suggestion!).join('\n') || undefined;
}
function redline(notice: Notice): boolean {
  return (notice.content.actionItems ?? notice.snapshot?.actionItems ?? []).some(item => item.label === '要你定·红线' || isRedline(`${item.text}\n${item.suggestion ?? ''}`));
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function isView(row: Row): row is ViewRow { return row.type === 'action' || row.type === 'result'; }

/** 转达的 journal/会话锁与检测、反馈、收件、卡片投递全部分开。外部执行绝不放进短锁。 */
export function relayController(config: Config, update: (row: { id: string; noticeId: string; messageId: string; view: RelayView }) => Promise<void>,
  reportError: (error: unknown) => Promise<void>) {
  const path = join(config.dataDir, 'relay.jsonl');
  const lock = <T>(operation: () => Promise<T>) => withNamedLock(config.dataDir, '.relay.lock', operation, 2000);
  const jobs = new Map<string, Promise<void>>(), abort = new AbortController();
  let ui: Promise<void> | undefined, preparing: Promise<void> | undefined, checking: Promise<void> | undefined, stopped = false, wakeAgain = false;
  function prepare() {
    preparing ??= recoverDeadLock(config.dataDir, '.relay.lock').then(() => recoverDeadLock(config.dataDir, '.relay-ui.lock'))
      .catch(error => { preparing = undefined; throw error; });
    return preparing;
  }
  async function rows(): Promise<Row[]> {
    const values = await readJsonl<Row>(path);
    if (values.some(row => !row || !['card', 'action', 'result', 'started', 'ui_done'].includes(row.type)
      || typeof row.id !== 'string' || !Number.isFinite(Date.parse(row.at))
      || (isView(row) && (!row.view || typeof row.messageId !== 'string' || typeof row.noticeId !== 'string'))))
      throw new RelayFailure('转达记录损坏，保留现场，未发送');
    return values;
  }
  async function save(row: Row) { await appendJsonl(path, [row]); }
  function wake() {
    if (stopped) return;
    if (ui) { wakeAgain = true; return; }
    wakeAgain = false;
    ui = (async () => {
      await prepare();
      await withNamedLock(config.dataDir, '.relay-ui.lock', async () => {
        // 一次显示任务可处理期间新增的预览/回执；不与收件或反馈共用网络锁。
        while (true) {
          const next = await lock(async () => {
            const all = await rows(), completed = new Set(all.filter(r => r.type === 'ui_done').map(r => r.id));
            return all.find((r): r is ViewRow => isView(r) && !completed.has(r.id));
          });
          if (!next) break;
          let ok = true;
          try { await update(next); } catch (error) { ok = false; await reportError(error); }
          await lock(() => save({ type: 'ui_done', id: next.id, at: at(), ok }));
        }
      });
    })().catch(async error => {
      // 另一实例正在更新时由它处理日志；其余错误留给存储告警，不输出原始异常。
      if ((error as { category?: string }).category !== 'lock_busy') await reportError(error);
    }).finally(() => { ui = undefined; if (wakeAgain) wake(); });
  }
  async function recordResult(attempt: Attempt, outcome: ResultRow['outcome'], view: RelayView) {
    await lock(async () => {
      if ((await rows()).some(row => row.type === 'result' && row.attemptId === attempt.id)) return;
      await save({ type: 'result', id: `result:${attempt.id}`, at: at(), attemptId: attempt.id, actor: attempt.actor,
        sessionId: attempt.target.sessionId, text: attempt.text, outcome, noticeId: attempt.noticeId, messageId: attempt.messageId, view });
    });
    wake();
  }
  function launch(attempt: Attempt) {
    // 只有刚刚持久化该 attempt 的处理者能到这里；重放、重复回调不进入外部执行。
    const job = (async () => {
      const name = `.relay-session-${hash(attempt.target.sessionId)}.lock`;
      try {
        await recoverDeadLock(config.dataDir, name);
        await withNamedLock(config.dataDir, name, async () => {
          const started = await lock(async () => {
            const all = await rows();
            if (all.some(row => (row.type === 'started' && row.id === attempt.id) || (row.type === 'result' && row.attemptId === attempt.id))) return false;
            await save({ type: 'started', id: attempt.id, at: at() }); return true;
          });
          if (!started) return;
          const transcript = await assertRelayIdle(config, attempt.target);
          if (transcript.cursor !== attempt.target.cursor) {
            const draft = { ...attempt.draft, id: hash(`changed:${attempt.id}:${transcript.cursor}`), target: { ...attempt.target, cursor: transcript.cursor } };
            await recordResult(attempt, 'changed', { stage: 'stale', draft, message: '会话已经往下走了，还送吗？' });
            return;
          }
          if (!config.relay?.enabled || abort.signal.aborted) throw new RelayFailure('转达总开关已关闭或服务正在停止');
          const result = await resumeCC(config, attempt.target, attempt.text, abort.signal);
          const reply = Array.from(result.reply);
          const shown = reply.length > 6000 ? `${reply.slice(0, 6000).join('')}\n（回复太长，已截断；全文在会话里）` : result.reply;
          const time = new Date().toLocaleString('zh-CN', { hour12: false });
          await recordResult(attempt, 'sent', done(`已送到，${time} 它回了：\n${shown}${result.denied.length ? `\n\n这一步被拦、要授权：${result.denied.join('、')}。请回电脑处理；不提供远程「允许」。` : ''}\n\n${WINDOW_WARNING}`));
        });
      } catch (error) {
        await recordResult(attempt, 'failed', done(`没送到：${(error as { category?: string }).category === 'lock_busy' ? '这个会话已有一笔转达在运行，不送' : relayFailureReason(error)}\n${WINDOW_WARNING}`));
      }
    })().catch(reportError).finally(() => { jobs.delete(attempt.id); wake(); });
    jobs.set(attempt.id, job);
  }
  return {
    async card(notice: Notice): Promise<RelayView | undefined> {
      if (!config.relay?.enabled || notice.tool !== 'cc' || notice.kind !== 'waiting') return undefined;
      await prepare();
      return lock(async () => {
        let card = (await rows()).find((row): row is CardRow => row.type === 'card' && row.id === notice.id);
        if (!card) {
          let target: RelayTarget | undefined, failure: string | undefined;
          try { target = await relayTarget(config, notice); } catch (error) { failure = relayFailureReason(error); }
          card = { type: 'card', id: notice.id, at: at(), target, suggestion: suggestion(notice), redline: redline(notice), failure };
          await save(card);
        }
        return { stage: 'entry', target: card.target, suggestion: card.suggestion, message: card.failure ? `没送到：${card.failure}` : undefined };
      });
    },
    async handle(input: RelayInput, notice: Notice): Promise<string | undefined> {
      await prepare();
      let attempt: Attempt | undefined;
      const response = await lock(async () => {
        const all = await rows();
        if (all.some(row => row.type === 'action' && row.id === input.id)) return undefined;
        const value = input.value ?? {}, card = all.find((row): row is CardRow => row.type === 'card' && row.id === notice.id);
        const append = async (view: RelayView, consumed?: string) => {
          await save({ type: 'action', id: input.id, at: at(), noticeId: notice.id, messageId: input.messageId, view, consumed, attempt });
        };
        if (!config.relay?.enabled || stopped) { await append(done('没送到：转达总开关已关闭')); return undefined; }
        if (notice.tool !== 'cc' || notice.kind !== 'waiting' || value.noticeId !== notice.id || !card?.target) {
          await append(done(`没送到：${card?.failure ?? '这张卡片没有可用的 CC 转达快照，请查看新卡片'}`)); return undefined;
        }
        const latest = all.filter(isView).findLast(row => row.messageId === input.messageId);
        if (latest?.view.stage === 'sending' || (latest?.type === 'result' && latest.outcome !== 'changed')) return '这次转达已处理，不会重复发送；请查看卡片回执。';
        if (value.action === 'relay_suggest' || value.action === 'relay_manual') {
          if (value.action === 'relay_manual') { await append({ stage: 'input', target: card.target }); return undefined; }
          if (!card.suggestion) { await append(done('没送到：没有可安全转达的建议，请使用手动输入')); return undefined; }
        }
        if (value.action === 'relay_suggest' || value.action === 'relay_input') {
          const text = value.action === 'relay_suggest' ? card.suggestion! : input.relayText;
          if (value.action === 'relay_input' && latest?.view.stage !== 'input') return '输入入口已更换，请重新点「手动输入」。';
          if (typeof text !== 'string' || !text.trim() || Array.from(text).length > RELAY_INPUT_LIMIT) {
            await append({ stage: 'input', target: card.target, message: `请输入 1–${RELAY_INPUT_LIMIT} 字的原话；不会截断或替你改写。` }); return undefined;
          }
          const draft: RelayDraft = { id: hash(`draft:${input.id}`), text, target: card.target,
            redline: card.redline || isRedline(text), redlineConfirmed: false };
          await append({ stage: 'preview', draft }); return undefined;
        }
        const draft = latest?.view.draft;
        if (draft && !all.some(row => row.type === 'ui_done' && row.id === latest!.id && row.ok)) return '预览卡片尚未成功更新，未发送；请等卡片更新后再确认。';
        if (!draft || value.draftId !== draft.id || all.some(row => row.type === 'action' && row.consumed === draft.id)) return '这份预览已处理或已更换，不会重复发送；请查看最新卡片。';
        if (value.action === 'relay_cancel') { await append(done('已取消，没送出。'), draft.id); return undefined; }
        const expected = { preview: 'relay_confirm', stale: 'relay_stale_confirm', redline: 'relay_red_confirm' }[latest!.view.stage as 'preview' | 'stale' | 'redline'];
        if (!expected || expected !== value.action) return '按钮与当前预览不匹配，未发送。';
        const nextDraft = { ...draft, id: hash(`draft:${input.id}`), redlineConfirmed: draft.redlineConfirmed || value.action === 'relay_red_confirm' };
        try {
          const current = await readRelayTranscript(config, draft.target.path);
          if (current.sessionId !== draft.target.sessionId || current.cwd !== draft.target.cwd) throw new RelayFailure('会话身份或工作目录变了，不送');
          if (current.cursor !== draft.target.cursor) {
            nextDraft.target = { ...draft.target, cursor: current.cursor };
            await append({ stage: 'stale', draft: nextDraft, message: '会话已经往下走了，还送吗？' }, draft.id); return undefined;
          }
          if (draft.redline && !nextDraft.redlineConfirmed) {
            await append({ stage: 'redline', draft: nextDraft, message: '卡片含红线条目，或原话涉及高风险操作，请再确认一次。不会替你点「允许」。' }, draft.id); return undefined;
          }
          // 预留先同步落盘，再在锁外启动。即使在落盘与 spawn 之间退出也不重放。
          attempt = { id: draft.id, at: at(), actor: input.actor, noticeId: notice.id, messageId: input.messageId,
            text: draft.text, target: draft.target, ownerPid: process.pid, draft: nextDraft };
          await append({ stage: 'sending', message: `正在转达给 CC 会话 ${draft.target.sessionId}；不会重复发送。\n${WINDOW_WARNING}` }, draft.id);
        } catch (error) { attempt = undefined; await append(done(`没送到：${relayFailureReason(error)}`), draft.id); }
        return undefined;
      });
      if (attempt) launch(attempt);
      wake();
      return response;
    },
    /** 仅将已失去处理者的未决笔记为不确定；绝不恢复执行或重试 CC。 */
    poll() {
      // 缺省关闭的旧配置不创建后台读写/锁；保留原收件完成即落稳的语义。
      if (!config.relay?.enabled && !preparing) return Promise.resolve();
      checking ??= (async () => {
        await prepare();
        const abandoned = await lock(async () => {
          const all = await rows(), finished = new Set(all.filter((r): r is ResultRow => r.type === 'result').map(r => r.attemptId));
          return all.filter((r): r is ActionRow => r.type === 'action' && !!r.attempt && !finished.has(r.attempt.id) && !alive(r.attempt.ownerPid)).map(r => r.attempt!);
        });
        for (const pending of abandoned) await recordResult(pending, 'failed', done(`没送到：上次转达中断，送达情况未确认；请回电脑核对，不会自动重发。\n${WINDOW_WARNING}`));
        wake();
      })().catch(reportError).finally(() => { checking = undefined; });
      return checking;
    },
    async settled() { while (jobs.size || ui || checking) { await Promise.all([...jobs.values(), ...(ui ? [ui] : []), ...(checking ? [checking] : [])]); } },
    async stop() { stopped = true; abort.abort(); await Promise.all(jobs.values()); if (checking) await checking; if (ui) await ui; },
  };
}
