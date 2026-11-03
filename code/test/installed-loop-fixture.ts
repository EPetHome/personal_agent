// 仅临时构造资源；加载本机Loop当前实现，不复制协议实现。
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
const [root, action] = process.argv.slice(2), input = JSON.parse(readFileSync(0, 'utf8'));
const load = (name: string) => import(pathToFileURL(join(root!, name)).href);
const events = await load('events.ts'), { processStartTime } = await load('procs.ts');
const info = events.batchInfo(input.file, input.project, input.dir);
const reason = { category: '需要你决定', text: '构造问题：选哪个？' }, detail = { next: 'send', question: '构造问题：选哪个？', options: ['选甲', '选乙'] };
if (action === 'emit') {
  events.writePhase(info, null, 'running', { status: 'started' });
  const started = events.pushEvent(info, '开发', 'started', events.eventReason(), {}, { prompt: input.prompt });
  events.writePhase(info, '开发', 'paused', { status: 'needs-decision', ...reason, next: 'send', detail, session: { host: 'pi', id: 'synthetic-session', pid: input.pid, processStarted: processStartTime(input.pid) } });
  const paused = events.pushEvent(info, '开发', 'needs-decision', reason, {}, detail);
  console.log(JSON.stringify({ started, paused }));
} else if (action === 'consume') {
  const { consumeRelay } = await load('pa.ts'), { relayMessage } = await load('pa-records.ts');
  console.log(JSON.stringify(await consumeRelay({ info, stage: '开发', session: { host: 'pi', id: 'synthetic-session' }, message: relayMessage(input.id, input.text) })));
} else if (action === 'resume') {
  const { resumeBatch } = await load('pa-resume.ts');
  events.writePhase(info, null, 'paused', { status: 'paused', next: input.next ?? 'resume', text: '构造整批暂停', detail: { next: input.next ?? 'resume' } });
  const result = await resumeBatch({ info, id: input.id, readGrant: () => input.text, launch: async (argv: string[]) => {
    writeFileSync(input.capture, JSON.stringify({ argv, text: input.text })); return { pid: input.pid, processStarted: processStartTime(input.pid) };
  } });
  console.log(JSON.stringify(result));
} else if (action === 'done-queue') {
  const detail = { branch: 'feat/test', commit: input.commit, gate: 'passed', review: { verdict: '通过', mustFix: 0, suggestions: 1 },
    acceptance: { verdict: '部分验证', failed: [], partial: [{ id: 'A2', text: '构造手机通知', detail: '尚未验证' }], manual: [{ id: 'A3', text: '构造人工文案', detail: '待本人体验' }] } };
  events.writePhase(info, '开发', 'done', { status: 'done', detail });
  events.writePhase(info, null, 'done', { status: 'done', detail });
  const done = events.pushEvent(info, null, 'done', events.eventReason(), {}, detail);
  const queue = events.pushEvent(info, null, 'queue', events.eventReason(), {}, { queueStatus: 'pending', position: 1, returnCount: 0 });
  console.log(JSON.stringify({ done, queue }));
} else if (action === 'queue') {
  console.log(JSON.stringify(events.pushEvent(info, null, 'queue', events.eventReason(), {}, { queueStatus: input.status, position: 1, returnCount: input.returns ?? 0 })));
} else if (action === 'running' || action === 'session') {
  if (action === 'running') events.writePhase(info, null, 'running', { status: 'started' });
  events.writePhase(info, '开发', 'running', { status: 'started', session: { host: 'pi', id: 'synthetic-session', pid: input.pid,
    processStarted: input.alive === false ? 'not-the-registered-start-time' : processStartTime(input.pid) } });
  const batch = action === 'running' ? events.pushEvent(info, null, 'started', events.eventReason()) : undefined;
  const stage = action === 'running' ? events.pushEvent(info, '开发', 'started', events.eventReason(), {}, { prompt: input.prompt }) : undefined;
  console.log(JSON.stringify({ batch, stage }));
} else if (action === 'phase') {
  events.writePhase(info, null, input.phase ?? 'paused', { status: input.status ?? 'paused', next: input.next ?? 'manual', text: '构造整批位置', detail: { branch: 'feat/test', commit: input.commit ?? 'a'.repeat(40), next: input.next ?? 'manual' } });
  console.log(JSON.stringify(events.pushEvent(info, null, input.status ?? 'paused', { category: '方法', text: '构造整批位置' }, {}, { next: input.next ?? 'manual' })));
} else throw new Error('未知夹具动作');
