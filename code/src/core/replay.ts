import { hash } from './utils.ts';
import type { ModelReplay } from './types.ts';

export interface ReplaySource { kind: 'session' | 'model_check' | 'notice_snapshot' | 'push'; key: string; data: unknown }
type Reference = NonNullable<ModelReplay['references']>[number];
const encoded = (text: string) => JSON.stringify(text).slice(1, -1);
const materialKeys = new Set(['intentOriginal', 'additionalRequirements', 'previousSummary', 'newSteps', 'assistantReply',
  'snapshotInput', 'snapshotInputsByStep', 'goal', 'currentTask', 'lastOutput', 'factualStatus', 'at', 'text']);
const factualStatuses = new Set(['在等你', '跑偏', '停滞', 'loop 完成', 'loop 暂停', '看不见了']);

/** 只保留程序生成的提示词模板；所有外部材料都引用已持久化事实，不以凭据正则判断能否明文保存。 */
export function protectReplay(replay: ModelReplay, sources: ReplaySource[]): ModelReplay {
  const strings: { source: Reference['source']; json: string }[] = [];
  function visit(data: unknown, kind: ReplaySource['kind'], key: string, path: (string | number)[]) {
    if (typeof data === 'string') strings.push({ source: { kind, key, path, valueSha256: hash(data) }, json: encoded(data) });
    else if (Array.isArray(data)) data.forEach((item, index) => visit(item, kind, key, [...path, index]));
    else if (data && typeof data === 'object') for (const [name, item] of Object.entries(data)) visit(item, kind, key, [...path, name]);
  }
  for (const { kind, key, data } of sources) visit(data, kind, key, []);
  const references: Reference[] = [];
  function reference(text: string): string {
    let result = '', cursor = 0;
    while (cursor < text.length) {
      const remaining = text.slice(cursor);
      let found: typeof strings[number] | undefined, start = 0, length = 0;
      for (const item of strings) {
        if (Math.min(item.json.length, remaining.length) <= length) continue;
        let low = length + 1, high = Math.min(item.json.length, remaining.length);
        if (!item.json.includes(remaining.slice(0, low))) continue;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (item.json.includes(remaining.slice(0, middle))) low = middle;
          else high = middle - 1;
        }
        found = item; length = low; start = item.json.indexOf(remaining.slice(0, length));
        if (length === remaining.length) break;
      }
      if (found) {
        let placeholder = `<replay-ref:${replay.inputSha256}:${references.length}>`;
        while (replay.input.prompt.includes(placeholder)) placeholder += '_';
        references.push({ placeholder, source: found.source, start, end: start + length });
        result += placeholder; cursor += length;
      } else {
        // 已有截断/压缩/首尾摘录可能引入空白和省略号；其余字符绝不作为明文兜底。
        const separator = /^(?: |…|\\[nrt])/.exec(remaining)?.[0];
        if (!separator) throw new Error('输入材料缺少可重建引用');
        result += separator; cursor += separator.length;
      }
    }
    return result;
  }
  function material(value: unknown, key?: string): string {
    if (value === null) return 'null';
    if (typeof value === 'string') {
      if (key === 'factualStatus' && factualStatuses.has(value)) return JSON.stringify(value);
      return `"${reference(encoded(value))}"`;
    }
    if (Array.isArray(value)) return `[${value.map(item => material(item)).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).map(([name, item]) => {
      if (!materialKeys.has(name)) throw new Error('输入材料结构不受支持');
      return `${JSON.stringify(name)}:${material(item, name)}`;
    }).join(',')}}`;
    throw new Error('输入材料结构不受支持');
  }
  try {
    // 这两个分隔符由 model.ts 的固定模板生成；JSON 内的同文换行已转义，不能冒充模板边界。
    const separator = replay.promptVersion.startsWith('snapshot-') ? '\n卡片材料：\n' : '\n材料：\n';
    const boundary = replay.input.prompt.lastIndexOf(separator);
    if (boundary < 0) throw new Error('输入缺少模板边界');
    const offset = boundary + separator.length;
    const prompt = replay.input.prompt.slice(0, offset) + material(JSON.parse(replay.input.prompt.slice(offset)));
    return { ...replay, input: { ...replay.input, prompt }, references };
  } catch {
    // 异常结构/无法引用也不泄露材料，更不能回退到原文；不改变或阻止原来的模型调用。
    return { ...replay, input: { ...replay.input, prompt: '[输入材料引用不可用]' }, references: [], unavailable: 'input_reference_unavailable' };
  }
}
/** resolver 从原事件（可先恢复归档）重放得到 source 对应的旧值；兼容旧版原文/局部引用记录。 */
export function restoreReplayInput(replay: ModelReplay, resolve: (source: Reference['source']) => string): ModelReplay['input'] {
  if (replay.unavailable) throw new Error('输入引用不可用，不能声称完整回放');
  let prompt = replay.input.prompt;
  for (const ref of replay.references ?? []) {
    const value = resolve(ref.source);
    if (hash(value) !== ref.source.valueSha256) throw new Error('回放引用校验不符');
    prompt = prompt.replace(ref.placeholder, () => encoded(value).slice(ref.start, ref.end));
  }
  const input = { ...replay.input, prompt };
  if (hash(JSON.stringify(input)) !== replay.inputSha256) throw new Error('完整输入 SHA-256 不符');
  return input;
}
