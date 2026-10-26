import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detect, rebuild } from '../src/core/agent.ts';
import { SourceReader } from '../src/core/source-reader.ts';
import { readEvents, readOutbox } from '../src/core/store.ts';
import { codex } from '../src/sources/codex/index.ts';
import { pi } from '../src/sources/pi/index.ts';
import { loop } from '../src/sources/loop/index.ts';
import { codexEvent, codexMeta, piHeader, piMessage, put, sandbox } from './fixtures.ts';

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(t: TestContext, tool: 'codex' | 'pi') {
  const f = await sandbox();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.sources.cc = null;
  f.config.sources[tool] = join(f.root, tool);
  const component = tool === 'codex' ? codex : pi;
  const file = join(f.config.sources[tool]!, 'subject.jsonl');
  const header = tool === 'codex' ? codexMeta('subject') : { ...piHeader(), id: 'subject' };
  const messages = tool === 'codex'
    ? [codexEvent({ type: 'user_message', message: '这个前缀不能成为正常记录' }), codexEvent({ type: 'task_complete' })]
    : [piMessage('u', null, 'user', '这个前缀不能成为正常记录'), piMessage('a', 'u', 'assistant', '已完成')];
  const valid = (id: string) => tool === 'codex'
    ? [codexMeta(id), codexEvent({ type: 'task_complete' })]
    : [{ ...piHeader(), id }, piMessage('u', null, 'user', '合法任务'), piMessage('a', 'u', 'assistant', '完成')];
  return { ...f, tool, component, file, header, messages, valid };
}

for (const tool of ['codex', 'pi'] as const) {
  for (const missing of ['id', 'cwd']) {
    test(`流式收尾：${tool} 缺 ${missing} 提前返回后仍校验坏尾行，完整指纹且不使用前缀`, async t => {
      const f = await fixture(t, tool);
      const header: any = structuredClone(f.header);
      delete (tool === 'codex' ? header.payload : header)[missing];
      const rows = [header, ...f.messages];
      const text = jsonl(rows) + '{"truncated":\n';
      await put(f.file, text);
      const handle = await open(f.file, 'r');
      try {
        const reader = new SourceReader(handle, f.component);
        assert.equal(f.component.parseRows!(reader.rows(), { path: f.file, fingerprint: '' }), null);
        reader.finish();
        assert.match(reader.error?.message ?? '', new RegExp(`第 ${rows.length + 1} 行无法解析为 JSON`));
        assert.equal(reader.fingerprint, sha(text));
      } finally { await handle.close(); }
      await put(join(f.config.sources[tool]!, 'healthy.jsonl'), f.valid('healthy'));
      const view = await detect(f.config, '2026-10-20T10:31:00Z');
      assert.deepEqual(view.records.map(r => [r.sessionId, r.status]), [['healthy', '已完成']]);
      const health = view.projection.health.get(tool)!;
      assert.equal(health.since, null, '单份坏文件不能拖正常会话失明');
      assert.equal(health.fileFailures?.count, 1);
      assert.deepEqual(health.fileStats, { total: 2, skipped: 0 });
      assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['unreadable']);
      assert.ok(!JSON.stringify(view.records).includes('这个前缀'));
      assert.equal((await detect(f.config, '2026-10-20T10:32:00Z')).noticesAdded, 0);
      assert.equal(await readFile(f.file, 'utf8'), text);
    });

    test(`流式收尾：${tool} 缺 ${missing} 但其余行合法，仍是非会话跳过而非文件故障`, async t => {
      const f = await fixture(t, tool);
      const header: any = structuredClone(f.header);
      delete (tool === 'codex' ? header.payload : header)[missing];
      const text = jsonl([header, ...f.messages, null, [f.header], { type: 'future', data: '😀'.repeat(17000) }]);
      await put(f.file, text);
      const handle = await open(f.file, 'r');
      try {
        const reader = new SourceReader(handle, f.component);
        assert.equal(f.component.parseRows!(reader.rows(), { path: f.file, fingerprint: '' }), null);
        reader.finish();
        assert.equal(reader.error, undefined);
        assert.equal(reader.fingerprint, sha(text));
      } finally { await handle.close(); }
      const view = await detect(f.config, '2026-10-20T10:31:00Z');
      assert.equal(view.records.length, 0);
      assert.equal(view.noticesAdded, 0);
      assert.equal(view.projection.health.get(tool)?.since, null);
      assert.equal(view.projection.health.get(tool)?.fileFailures, undefined);
      assert.deepEqual(view.projection.health.get(tool)?.fileStats, { total: 1, skipped: 1 });
    });
  }

  test(`流式收尾：${tool} 原有正常会话随后身份缺失且尾行损坏，不能健康消失`, async t => {
    const f = await fixture(t, tool);
    await put(f.file, f.valid('subject'));
    assert.equal((await detect(f.config, '2026-10-20T10:01:00Z')).records[0]?.status, '已完成');
    const prefix = await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8');
    const header: any = structuredClone(f.header);
    delete (tool === 'codex' ? header.payload : header).cwd;
    await put(f.file, jsonl([header, ...f.messages]) + '{"truncated":\n');
    const view = await detect(f.config, '2026-10-20T10:02:00Z');
    assert.deepEqual(view.records.map(r => [r.sessionId, r.status]), [['subject', '看不见了']]);
    assert.equal(view.projection.health.get(tool)?.fileFailures?.count, 1);
    assert.deepEqual(view.projection.health.get(tool)?.fileStats, { total: 1, skipped: 0 });
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), ['blind']);
    assert.deepEqual((await rebuild(f.config)).records, view.records);
    const count = (await readEvents(f.config.dataDir)).length;
    assert.equal((await detect(f.config, '2026-10-20T10:03:00Z')).noticesAdded, 0);
    assert.equal((await readEvents(f.config.dataDir)).length - count, 1);
    assert.ok((await readFile(join(f.config.dataDir, 'events.jsonl'), 'utf8')).startsWith(prefix));
  });
}

for (const damaged of [false, true]) {
  test(`流式收尾：Pi v1 ${damaged ? '坏尾不能冒充正常旧格式' : '合法旧格式照常跳过'}`, async t => {
    const f = await fixture(t, 'pi');
    await put(f.file, jsonl([{ type: 'header', version: 1, cwd: '/sample/old' }, { role: 'user', content: '旧格式' }]) + (damaged ? '{"bad":\n' : ''));
    const view = await detect(f.config, '2026-10-20T10:31:00Z');
    assert.equal(view.records.length, 0);
    assert.deepEqual(view.projection.health.get('pi')?.fileStats, { total: 1, skipped: damaged ? 0 : 1 });
    assert.equal(view.projection.health.get('pi')?.fileFailures?.count ?? 0, damaged ? 1 : 0);
    assert.deepEqual((await readOutbox(f.config.dataDir)).map(n => n.kind), damaged ? ['blind'] : []);
  });
}

test('流式收尾：完整指纹/原始行已读完不等于 JSONL 已校验', async t => {
  const f = await fixture(t, 'codex');
  const text = jsonl([codexMeta('subject')]) + '{"bad":\n';
  await put(f.file, text);
  const handle = await open(f.file, 'r');
  try {
    const reader = new SourceReader(handle, codex);
    for (const _ of reader.lines()) { /* 模拟已完整取得原始行/指纹但未做语法校验 */ }
    assert.equal(reader.fingerprint, sha(text));
    assert.deepEqual({ error: reader.error }, { error: undefined });
    reader.finish();
    assert.match(reader.error?.message ?? '', /第 2 行无法解析为 JSON/);
    assert.equal(reader.fingerprint, sha(text));
  } finally { await handle.close(); }
});

test('流式收尾：Markdown 只补齐指纹，不按 JSON 校验正文', async t => {
  const f = await fixture(t, 'pi');
  const text = '# 自动评审总结\n- 项目：/sample/project\n这不是 JSON，但可以是 Markdown。😀\n';
  await put(f.file, text);
  const handle = await open(f.file, 'r');
  try {
    const reader = new SourceReader(handle, loop);
    const lines = reader.lines()[Symbol.iterator]();
    lines.next();
    lines.return?.();
    reader.finish();
    assert.equal(reader.error, undefined);
    assert.equal(reader.fingerprint, sha(text));
  } finally { await handle.close(); }
});
