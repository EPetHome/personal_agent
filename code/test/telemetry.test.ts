import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotReplay } from '../src/core/model.ts';
import { protectReplay, restoreReplayInput } from '../src/core/replay.ts';
import { hash } from '../src/core/utils.ts';
import { ccAnswer, ccUser, unmanaged } from './fixtures.ts';
for (const material of ['Authorization: Basic ZmFrZS11c2VyOmZha2UtcGFzc3dvcmQ=', 'token=constructed-token-only', '构造引号"与换行\n😀'])
  test('保留模型留痕围栏：loop快照外部材料用引用，恢复后哈希一致', () => {
    const value = { goal: material, currentTask: null, lastOutput: material, factualStatus: 'loop 完成' as const };
    const raw = snapshotReplay({ executable: '/constructed', model: 'fake', timeoutMs: 100 }, value);
    const protectedInput = protectReplay(raw, [{ kind: 'notice_snapshot', key: 'key', data: value }]);
    assert.equal(protectedInput.unavailable, undefined); assert.ok(protectedInput.references!.length > 0);
    assert.ok(!protectedInput.input.prompt.includes(material));
    const restored = restoreReplayInput(protectedInput, source => {
      let result: any = value; for (const part of source.path) result = result[part]; return result;
    });
    assert.deepEqual(restored, raw.input); assert.equal(hash(JSON.stringify(restored)), raw.inputSha256);
  });
test('找不到引用不能回退明文；旧明文留痕仍可读', () => {
  const raw = snapshotReplay({ executable: '/constructed', model: 'fake', timeoutMs: 100 }, { goal: 'constructed-private', currentTask: null, lastOutput: 'token=constructed-only', factualStatus: 'loop 暂停' });
  const safe = protectReplay(raw, []); assert.equal(safe.unavailable, 'input_reference_unavailable'); assert.doesNotMatch(JSON.stringify(safe), /constructed-private|constructed-only/);
  assert.throws(() => restoreReplayInput(safe, () => ''), /引用不可用/); assert.deepEqual(restoreReplayInput(raw, () => ''), raw.input);
});
test('聊天埋点已删除：新问句/接话不再创建等待窗口、判断和影子事件', async t => {
  const answer = ccAnswer(); answer.message.content[0]!.text = '缓存多久？'; await unmanaged(t, 'cc', [ccUser(), answer, ccUser('十分钟', '2026-10-20T10:03:00Z')]);
});
