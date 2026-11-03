import { test } from 'node:test';
import { ccUser, ccCall, codexMeta, piHeader, unmanaged } from './fixtures.ts';
for (const tool of ['cc', 'codex', 'pi'] as const) for (const state of ['empty', 'metadata', 'broken', 'pending'])
  test(`停止扫描：${tool}/${state}不再制造空会话或坏会话提醒`, async t => {
    const rows = state === 'empty' ? '' : state === 'broken' ? '{broken json\n' : state === 'pending' ? [ccUser(), ccCall()]
      : [tool === 'pi' ? piHeader() : tool === 'codex' ? codexMeta() : { type: 'queue-operation' }];
    await unmanaged(t, tool, rows, { pushes: [{ tool, event: 'session_end', session_id: 'never-read', cwd: '/sample', transcript_path: '/constructed/missing', at: '2026-10-20T10:00:00Z' }] });
  });
