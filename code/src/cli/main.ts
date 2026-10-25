import { detect, overview, rebuild } from '../core/agent.ts';
import { loadConfig } from '../core/config.ts';
import { renderOverview } from '../core/judge.ts';
import { errorMessage, iso } from '../core/utils.ts';

const help = `personal agent（本批只读检测、文件发件）
用法：node code/src/cli/main.ts <detect|overview|rebuild> --config <绝对路径.json> [--now <ISO时间>] [--json]
  detect    检测一轮，追加事件/发件记录，重建当前状态
  overview  从事件推算总览，不读取来源、不生成提醒
  rebuild   只从事件重建 state.json，不读取来源、不发提醒
来源和数据目录没有默认值；使用说明见 code/使用说明.md。`;
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') { console.log(help); return; }
  const command = args.shift();
  if (!['detect', 'overview', 'rebuild'].includes(command ?? '')) throw new Error(help);
  let configPath: string | undefined;
  let now: string | undefined;
  let json = false;
  const seen = new Set<string>();
  while (args.length) {
    const arg = args.shift()!;
    if (seen.has(arg)) throw new Error(`参数重复：${arg}`);
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    if (!['--config', '--now'].includes(arg)) throw new Error(`未知参数：${arg}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    if (arg === '--config') configPath = value;
    else now = iso(value, '当前时间');
  }
  const config = await loadConfig(configPath);
  const view = command === 'detect' ? await detect(config, now)
    : command === 'rebuild' ? await rebuild(config, now) : await overview(config, now);
  if (json) {
    console.log(JSON.stringify({ at: view.at, records: view.records, health: [...view.projection.health.values()], ...('noticesAdded' in view ? { noticesAdded: view.noticesAdded } : {}) }, null, 2));
  } else {
    if ('noticesAdded' in view) console.log(`检测完成，新增 ${view.noticesAdded} 条发件记录。`);
    if (command === 'rebuild') console.log('已从 events.jsonl 重建 state.json。');
    console.log(renderOverview(view.records, view.projection));
  }
}
main().catch(error => { console.error(`错误：${errorMessage(error)}`); process.exitCode = 1; });
