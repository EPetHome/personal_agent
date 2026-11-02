/** Offline dataset validation only; no model, network, or product execution. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reused from Loop eval/yaml.ts; both projects accept the same YAML subset.
/** 本评测集约定的 YAML 子集；不接受锚点、标签、流式容器或多文档。 */
export function parseYaml(source: string): any {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const fail = (message: string): never => { throw new Error(`YAML 第 ${i + 1} 行：${message}`); };
  function uncomment(s: string) {
    let quote = '';
    for (let n = 0; n < s.length; n++) {
      const c = s[n];
      if (quote === '"' && c === '\\') { n++; continue; }
      if (quote === "'" && c === "'" && s[n + 1] === "'") { n++; continue; }
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '#' && (n === 0 || /\s/.test(s[n - 1]))) return s.slice(0, n).trimEnd();
    }
    return s.trimEnd();
  }
  const indent = (s: string) => {
    if (/^\s*\t/.test(s)) fail('缩进不能用 Tab');
    return s.length - s.trimStart().length;
  };
  const skip = () => { while (i < lines.length && !uncomment(lines[i]).trim()) i++; };
  function scalar(s: string): any {
    if (s === 'null') return null;
    if (s === 'true' || s === 'false') return s === 'true';
    if (s === '[]') return [];
    if (s === '{}') return {};
    if (s.startsWith('"')) { try { return JSON.parse(s); } catch { fail('无效双引号字符串'); } }
    if (s.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(s)) fail('无效单引号字符串');
      return s.slice(1, -1).replace(/''/g, "'");
    }
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
      const value = Number(s);
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('数字超出安全范围');
      return value;
    }
    if (!s || /^[\[\]{}&*!>|%@`]/.test(s) || /^(---|\.\.\.)$/.test(s) || /:\s|:$/.test(s)) fail('不支持的 YAML 写法');
    return s;
  }
  function pair(s: string): [string, string] | null {
    const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+):(?:\s+(.*)|$)/.exec(s);
    if (!m) return null;
    const key = m[1].trim();
    return [key.startsWith('"') || key.startsWith("'") ? scalar(key) : key, m[2]?.trim() ?? ''];
  }
  function value(s: string, level: number): any {
    if (s === '|') {
      const start = i;
      while (i < lines.length && !lines[i].trim()) i++;
      const size = i < lines.length ? indent(lines[i]) : level;
      if (size <= level) return '';
      i = start;
      const body: string[] = [];
      while (i < lines.length) {
        if (lines[i].trim() && indent(lines[i]) < size) break;
        body.push(lines[i].trim() ? lines[i].slice(size) : ''); i++;
      }
      return body.join('\n').replace(/\n*$/, '\n');
    }
    if (s) return scalar(s);
    skip();
    if (i >= lines.length || indent(lines[i]) <= level) fail('空值请显式写 null、[] 或 {}');
    return block(indent(lines[i]));
  }
  function block(level: number): any {
    skip();
    const list = /^-(?:\s|$)/.test(uncomment(lines[i]).trimStart());
    const out: any = list ? [] : {};
    while (i < lines.length) {
      skip(); if (i >= lines.length || indent(lines[i]) < level) break;
      if (indent(lines[i]) !== level) fail('缩进不匹配');
      const s = uncomment(lines[i]).slice(level);
      if (list) {
        if (!/^-(?:\s|$)/.test(s)) fail('列表中混入映射');
        const rest = s.slice(1).trimStart();
        if (pair(rest)) {
          lines[i] = ' '.repeat(level + 2) + rest;
          out.push(block(level + 2));
        } else { i++; out.push(value(rest, level)); }
      } else {
        const p = pair(s);
        if (!p) fail('需要映射键');
        if (p[0] === '<<' || Object.hasOwn(out, p[0])) fail('合并键或重复键');
        i++;
        Object.defineProperty(out, p[0], { value: value(p[1], level), enumerable: true, writable: true, configurable: true });
      }
    }
    return out;
  }
  skip(); if (i === lines.length) fail('空文档');
  if (indent(lines[i]) !== 0) fail('根节点不能缩进');
  const first = uncomment(lines[i]);
  const result = !pair(first) && !/^-(?:\s|$)/.test(first) ? (i++, scalar(first)) : block(0);
  skip(); if (i < lines.length) fail('文档尾部存在多余内容');
  return result;
}

const caseKeys = ['id', '标题', '来源', '层', '状态', '失败类别', '被测对象', '题目', '初始环境',
  '结果判定', '参考案例', '过程断言', '关键决策点', '证据', '扩展', '修订'];
function object(v: any, label: string) {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v), `${label}: 需要映射`);
}
function fields(v: any, keys: string[], label: string) {
  object(v, label);
  for (const key of keys) assert.ok(Object.hasOwn(v, key), `${label}: 缺少 ${key}`);
}
function string(v: any, label: string) { assert.ok(typeof v === 'string' && v.trim(), `${label}: 需要非空字符串`); }
function list(v: any, label: string) { assert.ok(Array.isArray(v), `${label}: 需要列表`); }

export function check(root = dirname(fileURLToPath(import.meta.url))) {
  const base = realpathSync(root);
  function local(path: string, scope?: string) {
    string(path, '引用路径');
    assert.ok(!path.startsWith('/') && !path.split(/[\\/]/).includes('..'), '引用必须是评测根内的相对路径');
    const full = resolve(base, path);
    assert.ok(existsSync(full), `${path}: 引用文件不存在`);
    assert.ok(statSync(full).isFile(), `${path}: 引用不是文件`);
    const actual = realpathSync(full);
    assert.ok(actual.startsWith(base + sep), `${path}: 引用越界`);
    if (scope) assert.ok(actual.startsWith(resolve(base, scope) + sep), `${path}: 超出本题目录`);
    return full;
  }
  const points = new Set([...readFileSync(join(base, '判定点.md'), 'utf8').matchAll(/^## ([A-Z]\d+) /gm)].map(m => m[1]));
  assert.ok(points.size, '判定点为空');
  const names = readdirSync(join(base, 'cases')).filter(n => n.endsWith('.yaml')).sort();
  assert.ok(names.length, '没有题目；真实题库被 Git 忽略，检出仓库不会自动带入本机材料');
  const bySource: Record<string, number> = {};
  const ids = new Set<string>();
  let files = 0;
  for (const name of names) {
    const c = parseYaml(readFileSync(join(base, 'cases', name), 'utf8'));
    fields(c, caseKeys, name);
    assert.deepEqual(Object.keys(c).sort(), [...caseKeys].sort(), `${name}: 顶层字段不符合统一结构`);
    assert.match(c.id, /^(J|W)\d{3,}$/);
    assert.equal(name, c.id + '.yaml', `${name}: 编号与文件名不一致`);
    assert.ok(!ids.has(c.id), `${name}: 重复编号`); ids.add(c.id);
    for (const k of ['标题','来源','层','状态','被测对象']) string(c[k], `${c.id}.${k}`);
    assert.ok(['线上反馈','事故','漏网','手造','干净'].includes(c.来源), `${c.id}: 未知来源`);
    assert.ok(['能力','回归'].includes(c.层), `${c.id}: 未知层`);
    assert.equal(c.被测对象, 'personal agent');
    for (const k of ['失败类别','结果判定','参考案例','关键决策点','证据','修订']) list(c[k], `${c.id}.${k}`);
    fields(c.题目, ['原文','附件'], c.id + '.题目'); list(c.题目.附件, c.id + '.附件');
    string(c.题目.原文, c.id + '.原文');
    if (c.题目.原文.startsWith('cases/')) local(c.题目.原文, `cases/${c.id}`);
    for (const path of c.题目.附件) local(path, `cases/${c.id}`);
    for (const path of c.证据) local(path, `cases/${c.id}`);
    const env = c.初始环境;
    fields(env, ['版本','模型','可回放','不可回放原因','其他'], c.id + '.初始环境'); object(env.其他, c.id + '.其他');
    for (const k of ['版本','模型']) assert.ok(env[k] === null || typeof env[k] === 'string', `${c.id}.${k}: 需要字符串或 null`);
    assert.equal(typeof env.可回放, 'boolean', `${c.id}: 可回放必须是布尔值`);
    if (!env.可回放) string(env.不可回放原因, `${c.id}: 不可回放原因`);
    else assert.equal(env.不可回放原因, null, `${c.id}: 可回放与原因冲突`);
    assert.ok(c.结果判定.length, `${c.id}: 缺少判定`);
    for (const p of c.结果判定) {
      fields(p, ['判定点','类型','本题判法'], c.id + '.结果判定'); string(p.本题判法, c.id + '.本题判法');
      assert.ok(['底线','质量','成本','风格'].includes(p.类型), `${c.id}: 未知判定类型`);
      assert.ok(points.has(p.判定点) || (p.条款 && p.为什么只属于本题), `${c.id}: 未定义判定点 ${p.判定点}`);
    }
    for (const r of c.参考案例) fields(r, ['id','出处','评价'], c.id + '.参考案例');
    fields(c.过程断言, ['必须','绝不','顺序','步数上限'], c.id + '.过程断言');
    for (const k of ['必须','绝不','顺序']) {
      list(c.过程断言[k], `${c.id}.${k}`);
      for (const p of c.过程断言[k]) if (typeof p === 'string' && /^[A-Z]\d+$/.test(p)) {
        assert.ok(points.has(p), `${c.id}: 未定义过程判定点 ${p}`);
      }
    }
    assert.ok(c.过程断言.步数上限 === null || (Number.isSafeInteger(c.过程断言.步数上限) && c.过程断言.步数上限 >= 0));
    object(c.扩展, c.id + '.扩展'); assert.ok(c.修订.length, `${c.id}: 缺少修订`);
    for (const r of c.修订) { fields(r, ['版本','日期','内容'], c.id + '.修订'); assert.match(r.日期, /^\d{4}-\d{2}-\d{2}$/); }
    const manifestPath = `cases/${c.id}/冻结清单.json`;
    const manifest = JSON.parse(readFileSync(local(manifestPath), 'utf8'));
    assert.equal(manifest.caseId, c.id); list(manifest.文件, c.id + '.冻结清单');
    assert.ok(manifest.文件.length, `${c.id}: 冻结清单为空`);
    const frozen = new Set<string>();
    for (const f of manifest.文件) {
      fields(f, ['文件','sha256','原路径','行号范围','用途'], c.id + '.冻结项');
      assert.ok(!frozen.has(f.文件), `${c.id}: 重复冻结项`); frozen.add(f.文件);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      const bytes = readFileSync(local(f.文件, `cases/${c.id}`));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256, `${c.id}: sha256 不一致 (${f.文件})`);
      files++;
    }
    for (const path of c.题目.附件) if (path !== manifestPath) assert.ok(frozen.has(path), `${c.id}: 附件未列入冻结清单`);
    if (c.题目.原文.startsWith('cases/')) assert.ok(frozen.has(c.题目.原文), `${c.id}: 题目未冻结`);
    if (env.可回放) assert.ok(c.扩展.片段?.length, `${c.id}: 可回放却没有会话片段`);
    for (const p of c.扩展.片段 ?? []) {
      assert.ok(frozen.has(p.文件), `${c.id}: 会话片段未冻结`);
      const end = Date.parse(p.截止); assert.ok(Number.isFinite(end));
      for (const line of readFileSync(local(p.文件), 'utf8').trim().split('\n')) {
        const r = JSON.parse(line), t = Date.parse(r.timestamp ?? r.at ?? r.message?.timestamp);
        assert.ok(Number.isFinite(t) && t <= end, `${c.id}: 片段包含无时间或晚于证据的记录`);
      }
    }
    bySource[c.来源] = (bySource[c.来源] ?? 0) + 1;
  }
  const inventory = JSON.parse(readFileSync(join(base, '待标注', '采集依据.json'), 'utf8'));
  assert.equal(inventory.caseCount, ids.size, '采集清单与题数不一致');
  assert.deepEqual(new Set(inventory.cases.map((c: any) => c.id)), ids, '采集清单编号不一致');
  assert.equal(inventory.feedbackMap.length, inventory.sourceSnapshots['feedback.jsonl'].rows, '反馈未全部登记');
  assert.equal(new Set(inventory.feedbackMap.map((f: any) => f.反馈)).size, inventory.feedbackMap.length, '反馈重复登记');
  for (const row of inventory.feedbackMap) assert.ok(ids.has(row.题目), '反馈引用题号不存在');
  for (const row of inventory.reconciliation) if (!row.匹配卡片) assert.ok(ids.has(row.题目), '未对应事件未建题');
  const matched = inventory.reconciliation.filter((r: any) => r.匹配卡片);
  assert.equal(new Set(matched.map((r: any) => r.匹配卡片)).size, matched.length, '同一卡片被多次用作召回命中');
  return { 题目总数: ids.size, 按来源: bySource, 冻结文件数: files, 反馈条数: inventory.feedbackMap.length, 模型调用: 0, 回放: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(check(), null, 2)); }
  catch (e) { console.error(e instanceof Error ? e.message : '检查失败'); process.exitCode = 1; }
}

