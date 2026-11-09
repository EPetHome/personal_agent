#!/usr/bin/env node
// Assembly-only receiver probe. It generates no producer records and invokes no model/worker/channel.
import { lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig } from '../dist/src/config.js';
import { Store } from '../dist/src/store.js';
import { Files } from '../dist/src/files.js';
import { PiObservation } from '../dist/src/pi-observation.js';
import { canonical, inside } from '../dist/src/util.js';

const usage = '用法：node scripts/verify-work-tracking.mjs --config /临时沙盒/config.json [--expect-session 原构造sessionId] [--min-executions 1]\n只接收所给临时配置中乙实际导出的构造记录，不造生产者样例、不调用模型/飞书/业务 Pi。dataDir 必须是空临时目录。单次检查后退出，不常驻；中断可 Ctrl-C。';
if (process.argv.some(a => ['--help', '-h'].includes(a))) { console.log(usage); process.exit(0); }
try {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--config', '--expect-session', '--min-executions'].includes(key) || !value || args[key]) throw new Error(usage);
    args[key] = value;
  }
  if (!args['--config']) throw new Error(usage);
  const temp = await canonical(tmpdir()), path = await canonical(resolve(args['--config']));
  if (!inside(temp, path) || path === temp || (await lstat(path)).size > 64 * 1024) throw new Error('只接受临时目录内的小型构造配置，不读取正式配置');
  const c = await loadConfig(path);
  if (c.model.auth.type !== 'none' || c.feishu.mode !== 'fake' || !c.piObservation?.sources.length) throw new Error('须使用本地模型/渠道替身配置及显式观察来源');
  const paths = [c.dataDir, c.attachmentDir, ...c.projects.map(p => p.root), ...c.piObservation.sources.flatMap(s => [s.exportRoot, ...s.cwds])];
  if (paths.some(p => p === temp || !inside(temp, p))) throw new Error('所有材料、导出根和接收数据须在临时沙盒内；不连接真实会话');
  if ((await readdir(c.dataDir).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).length) throw new Error('接收 dataDir 非空，未修改；另用空沙盒接收数据目录');
  const minimum = Number(args['--min-executions'] ?? 1); if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('min-executions 须为非负整数');
  c.intake.watch = false;
  const store = new Store(c), observer = new PiObservation(c, store, new Files(c, store));
  try {
    let pages = 0; while (await observer.scan(pages > 0)) { if (++pages > 1000) throw new Error('达到有界接收上限，未称完整覆盖'); }
    const records = []; let offset = 0;
    while (true) {
      const page = await observer.page(offset, 50);
      if (page.partial) throw new Error(`来源尚未完整核实：${JSON.stringify(page.coverage)}`);
      records.push(...page.rows); if (!page.hasMore) break; offset = page.nextOffset;
    }
    const executions = records.filter(r => r.kind === 'execution');
    if (executions.length < minimum || args['--expect-session'] && !records.some(r => r.sessionId === args['--expect-session'])) throw new Error('未收到预期原构造会话/执行身份，不能宣称对接成功');
    console.log(JSON.stringify({ ok: true, protocol: 1, producer: '外部提供的原始导出文件；本脚本未生成', records: records.length, executions: executions.length, tasks: store.taskTable().length, identities: records.map(({ sourceId, sessionId, instanceId, executionId, revision, state }) => ({ sourceId, sessionId, instanceId, executionId, revision, state })), businessAcceptance: '未验证', semanticChecks: '未执行' }, null, 2));
  } finally { await observer.stop(); store.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : '构造接收检查失败'); process.exitCode = 1; }
