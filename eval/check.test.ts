import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, parseYaml } from './check.ts';

test('统一 YAML 子集：嵌套、引号、注释、多行；拒绝重复键及扩展语法', () => {
  const x = parseYaml('id: "J001" # note\na:\n  - p: true\n    text: |\n      a:b\n      # literal\nb: []\nc: {}\nd: null\n');
  assert.deepEqual(x, { id: 'J001', a: [{ p: true, text: 'a:b\n# literal\n' }], b: [], c: {}, d: null });
  for (const bad of ['a: 1\na: 2', 'a: &ref value', 'a: [1, 2]', 'a:\n', '---\na: 1', 'a: *ref']) {
    assert.throws(() => parseYaml(bad));
  }
});

test('离线检查能阻止篡改、缺字段、未知判定点、丢失引用和越界路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-eval-check-'));
  try {
    mkdirSync(join(dir, 'cases', 'J001'), { recursive: true });
    mkdirSync(join(dir, '待标注'));
    writeFileSync(join(dir, '判定点.md'), '## T1 状态判对\n');
    const body = 'synthetic observation\n', bodyPath = join(dir, 'cases', 'J001', '题目.md');
    writeFileSync(bodyPath, body);
    writeFileSync(join(dir, 'cases', 'J001', '冻结清单.json'), JSON.stringify({ caseId: 'J001', 文件: [{
      文件: 'cases/J001/题目.md', sha256: createHash('sha256').update(body).digest('hex'), 原路径: null, 行号范围: null, 用途: '题目',
    }] }));
    writeFileSync(join(dir, '待标注', '采集依据.json'), JSON.stringify({ caseCount: 1, cases: [{ id: 'J001' }],
      sourceSnapshots: { 'feedback.jsonl': { rows: 0 } }, feedbackMap: [], reconciliation: [] }));
    const text = `id: J001
标题: 构造检查题
来源: 手造
层: 回归
状态: 待补证
失败类别: []
被测对象: personal agent
题目:
  原文: cases/J001/题目.md
  附件:
    - cases/J001/冻结清单.json
初始环境:
  版本: null
  模型: null
  可回放: false
  不可回放原因: 构造检查
  其他: {}
结果判定:
  - 判定点: T1
    类型: 底线
    本题判法: 检查结构
参考案例: []
过程断言:
  必须: []
  绝不: []
  顺序: []
  步数上限: null
关键决策点: []
证据: []
扩展: {}
修订:
  - 版本: v1
    日期: "2026-10-31"
    内容: 构造检查
`;
    const casePath = join(dir, 'cases', 'J001.yaml');
    writeFileSync(casePath, text);
    assert.equal(check(dir).题目总数, 1);
    writeFileSync(bodyPath, body.replace('observation', 'tampered'));
    assert.throws(() => check(dir), /J001: sha256 不一致/);
    writeFileSync(bodyPath, body);
    for (const [changed, expected] of [
      [text.replace('状态: 待补证\n', ''), /缺少 状态/],
      [text.replace('判定点: T1', '判定点: T999'), /未定义判定点/],
      [text.replace('原文: cases/J001/题目.md', '原文: cases/J001/不存在.md'), /引用文件不存在/],
      [text.replace('- cases/J001/冻结清单.json', '- ../outside'), /相对路径/],
    ] as const) {
      writeFileSync(casePath, changed); assert.throws(() => check(dir), expected);
    }
    writeFileSync(casePath, text);
    assert.equal(check(dir).题目总数, 1);
    assert.equal(readFileSync(bodyPath, 'utf8'), body);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
