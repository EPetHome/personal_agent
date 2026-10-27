import type { HookTool } from './protocol.ts';

export const market = 'personal-agent-local';
export const plugin = `message-listener@${market}`;
/** 官方管理命令实际改动的配置/登记白名单；插件缓存不是配置，不递归备份。 */
export const configPaths: Record<HookTool, string[]> = {
  cc: ['.claude/settings.json', '.claude/plugins/installed_plugins.json', '.claude/plugins/known_marketplaces.json'],
  codex: ['.codex/config.toml'],
  pi: ['.pi/agent/settings.json'],
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置/登记不是 JSON 对象，未改动');
  return value as Record<string, unknown>;
}
/** TOML 这里只定位表边界，不重序列化用户配置；引号/多行字符串里的 [表] 不是表。 */
function tableKeys(line: string): string[] | null {
  const match = /^\s*\[\[?\s*(.*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  const keys: string[] = [];
  let rest = match[1]!;
  while (rest) {
    const key = /^(?:([\w-]+)|'([^']*)'|("(?:[^"\\]|\\.)*"))\s*(?:\.\s*|$)/.exec(rest);
    if (!key) return null;
    keys.push(key[1] ?? key[2] ?? JSON.parse(key[3]!));
    rest = rest.slice(key[0].length);
  }
  return keys.length ? keys : null;
}
function multilineState(line: string, state: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    if (state) {
      if (state === '"""' && line[i] === '\\') { i++; continue; }
      if (line.startsWith(state, i)) { i += 2; state = ''; }
    } else if (quote) {
      if (quote === '"' && line[i] === '\\') { i++; continue; }
      if (line[i] === quote) quote = '';
    } else if (line[i] === '#') break;
    else if (line.startsWith('"""', i) || line.startsWith("'''", i)) { state = line.slice(i, i + 3); i += 2; }
    else if (line[i] === '"' || line[i] === "'") quote = line[i]!;
  }
  return state;
}
function cleanToml(text: string, baseline = ''): string {
  const isOwned = (keys: string[]) => (keys[0] === 'plugins' && keys[1] === plugin) || (keys[0] === 'marketplaces' && keys[1] === market);
  const originalTables = new Set<string>();
  let state = '';
  for (const line of baseline.split('\n')) {
    const keys = state ? null : tableKeys(line);
    if (keys && isOwned(keys)) originalTables.add(JSON.stringify(keys.slice(0, 2)));
    state = multilineState(line, state);
  }
  state = '';
  let removing = false;
  let table: string[] = [];
  const kept: string[] = [];
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const keys = state ? null : tableKeys(line.trimEnd());
    if (keys) {
      table = keys;
      removing = isOwned(keys) && !originalTables.has(JSON.stringify(keys.slice(0, 2)));
    }
    if (!state && !keys && !removing && ((table.length === 1 && ['plugins', 'marketplaces'].includes(table[0]!)
      && new RegExp(`^\\s*["']?(?:${plugin.replaceAll('.', '\\.') }|${market})["']?\\s*=`).test(line))
      || (/^\s*(?:plugins|marketplaces)\s*=/.test(line) && (line.includes(plugin) || line.includes(market))))) {
      throw new Error('Codex 自有登记的写法已变化，保留现场，未自动卸载');
    }
    if (!removing) kept.push(line);
    state = multilineState(line, state);
  }
  return kept.join('');
}
/** 只删自己的键。baseline 只用来识别原来就有的空容器，绝不恢复其中的设置值。 */
export function removeEntries(tool: HookTool, path: string, text: string, extension: string, baseline?: string): string | undefined {
  if (tool === 'codex') {
    const cleaned = cleanToml(text, baseline);
    return baseline === undefined && !cleaned.trim() ? undefined : cleaned;
  }
  const value = object(JSON.parse(text));
  const original = baseline === undefined ? {} : object(JSON.parse(baseline));
  if (tool === 'pi') {
    if (value.extensions !== undefined) {
      if (!Array.isArray(value.extensions)) throw new Error('Pi extensions 配置无效，未改动');
      if (value.extensions.includes(extension)) {
        let originals = Array.isArray(original.extensions) ? original.extensions.filter(item => item === extension).length : 0;
        const extensions = value.extensions.filter(item => item !== extension || originals-- > 0);
        value.extensions = extensions;
        if (!extensions.length && !Object.hasOwn(original, 'extensions')) delete value.extensions;
      }
    }
  } else {
    const maps = path.endsWith('/settings.json') ? [['enabledPlugins', plugin], ['extraKnownMarketplaces', market]]
      : path.endsWith('/installed_plugins.json') ? [['plugins', plugin]] : [['', market]];
    for (const [container, key] of maps as [string, string][]) {
      if (!container) { if (!Object.hasOwn(original, key)) delete value[key]; continue; }
      if (value[container] === undefined) continue;
      const map = object(value[container]);
      if (!Object.hasOwn(map, key) || (original[container] !== undefined && Object.hasOwn(object(original[container]), key))) continue;
      delete map[key];
      if (!Object.keys(map).length && !Object.hasOwn(original, container)) delete value[container];
    }
  }
  if (JSON.stringify(value) === JSON.stringify(object(JSON.parse(text)))) return text;
  if (baseline === undefined && (!Object.keys(value).length
    || (path.endsWith('/installed_plugins.json') && Object.keys(value).length === 1 && value.version === 2))) return undefined;
  return JSON.stringify(value, null, 2) + '\n';
}
