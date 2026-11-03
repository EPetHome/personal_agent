// 真机发现的旧聊天问题现在统一验证为不再监控；不访问真机。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loop } from '../src/sources/loop/index.ts';
import { truncateText } from '../src/core/utils.ts';
import { replyExcerpt } from '../src/core/notice-text.ts';
import { ccUser, ccCall, ccAnswer, loopSummary, unmanaged, start } from './fixtures.ts';
for (const state of ['early-push', 'missing-transcript', 'bad-path', 'late-turn', 'model-failure']) test(`旧聊天真机回归 ${state}不再出卡或调用模型`, async t => {
  const answer = ccAnswer(); answer.message.content[0]!.text = '明确需要你选方案？';
  await unmanaged(t, 'cc', state === 'missing-transcript' ? '' : [ccUser(), ccCall(), answer],
    { pushes: [{ tool: 'cc', event: 'turn_end', session_id: 'unknown', cwd: '/sample', transcript_path: '/constructed/not-read', at: start, detail: '确认吗？' }] });
});
test('loop 还欠事项保留：多节人工/小问题汇总合并，不读正文中的文件路径', () => {
  const text = loopSummary('完成', '/sample/project', '- A1 [人工] 确认文案') + '\n## 小问题汇总\n- 一个小问题\n## 验收额外发现\n- 一项额外发现\n';
  const record = loop.parse(text, { path: '/constructed/p/11111111-1111-4111-8111-111111111111.md', fingerprint: 'fp' });
  assert.equal(record!.project, '/sample/project'); assert.equal(record!.loop!.needs.length, 3);
});
test('保留长文本边界：Unicode截断完整，证据首尾都保留', () => {
  const text = '开头' + '😀'.repeat(5000) + '末尾问题？';
  assert.ok([...truncateText(text, 1200)].length <= 1201); const result = replyExcerpt(text);
  assert.ok([...result].length <= 1200); assert.match(result, /^开头/); assert.match(result, /末尾问题？$/); assert.doesNotMatch(result, /[\ud800-\udbff]$/);
});
