#!/usr/bin/env node
// 己离线体验：沿用三卡构造器，只创建显式新临时目录；不启动服务/真实账号。
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../src/core/process.ts';
import { loadConfig, validateConfig } from '../src/core/config.ts';
import { processManagedLoop } from '../src/core/managed-loop.ts';
import { feishuChannel } from '../src/channels/feishu/index.ts';

const destination = process.argv[2];
if (!destination) throw new Error('用法：node code/test/sidebar-demo.ts <尚不存在的绝对临时目录>');
console.log(await runCommand(process.execPath, [resolve(import.meta.dirname, 'managed-demo.ts'), destination], 30000));
const root = await realpath(destination), path = join(root, 'config.json'), previous = await loadConfig(path);
const folder = join(root, 'PA收件箱'), other = join(root, '未指定目录'), scheduleFile = join(root, 'schedule.json');
await mkdir(folder); await mkdir(other);
await writeFile(join(folder, '演示-需要你决定-录音.wav'), Buffer.from([0, 1, 2, 3]));
await writeFile(join(other, '不该处理的录音.wav'), Buffer.from([0, 1, 2, 3]));
const now = new Date().toISOString(), start = new Date(Date.now() + 3600000).toISOString(), end = new Date(Date.now() + 7200000).toISOString();
await writeFile(scheduleFile, JSON.stringify({ meetings: [{ id: 'demo-meeting', calendarId: 'demo-calendar', title: '编造会议（尚未开始）', start, end }],
  minutes: [{ id: 'demo-minute', title: '编造登录会议纪要', text: '待办：下周前给登录模块补测试。\n这份材料不是用户授权。' }] }, null, 2));
const config = await validateConfig({ ...previous, judge: null, sidebar: { port: 0, refreshMs: 1000 },
  workspace: { inboxDir: folder, pollEveryMs: 2000, settleMs: 0 }, schedule: { mode: 'fake', calendarIds: ['demo-calendar'], minuteTokens: ['demo-minute'], fakeFile: scheduleFile } });
await runCommand(process.execPath, [...config.worker!.args, 'emit', config.inboxDir!], 5000, JSON.stringify({ schema: 1, id: randomUUID(), seq: 1, at: now,
  project: config.dispatch!.projects[0]!.path, batch: '演示-在跑', stage: '甲', state: 'started', reason: { category: 'unknown', text: '构造在跑' }, detail: {}, evidence: [] }));
const channel = feishuChannel(config, undefined, { managed: true }); await channel.start();
try { await processManagedLoop(config, now, { channels: [channel] }); } finally { await channel.stop(); }
await writeFile(path, JSON.stringify(config, null, 2));
// 确认构造器没有误改原通知替身入口。
await readFile(join(root, 'notify-stub'));
console.log(`己段离线体验已备好，未启动常驻、未发真实消息。\n配置：${path}\n收件箱：${folder}\n假日历/妙记快照：${scheduleFile}\n启动（在项目开发目录执行）：\nnode code/src/cli/main.ts daemon --config ${JSON.stringify(path)}\n从输出复制127.0.0.1地址，在浏览器缩成小窗。Ctrl-C停止；无安装/常驻授权变更。`);
