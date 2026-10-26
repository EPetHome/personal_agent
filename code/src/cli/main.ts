import { detect, overview, rebuild } from '../core/agent.ts';
import { loadConfig } from '../core/config.ts';
import { renderOverview } from '../core/judge.ts';
import { receiveFeedback } from '../core/feedback.ts';
import { evaluate } from '../core/evaluate.ts';
import { errorMessage, iso } from '../core/utils.ts';

const help = `personal agent（只读盯防、可选模型与本机渠道）
用法：node code/src/cli/main.ts <detect|overview|rebuild> --config <绝对路径.json> [--now <ISO时间>] [--json]
      node code/src/cli/main.ts feedback <正确|误报|漏了> [说明] --config <绝对路径.json> [--id <提醒编号>|--unlinked] [--now <ISO时间>]
      node code/src/cli/main.ts evaluate --samples <样本目录> --config <绝对路径.json> [--json]
  detect    检测一轮，追加事件/发件记录，重建当前状态
  overview  从事件推算总览，不读取来源、不生成提醒
  rebuild   只从事件重建 state.json，不读取来源、不发提醒
来源和数据目录没有默认值；使用说明见 code/使用说明.md。`;
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') { console.log(help); return; }
  const command = args.shift();
  if (!['detect', 'overview', 'rebuild', 'feedback', 'evaluate'].includes(command ?? '')) throw new Error(help);
  const feedbackWords: string[] = [];
  if (command === 'feedback') while (args[0] && !args[0].startsWith('--')) feedbackWords.push(args.shift()!);
  let noticeId: string | null | undefined;
  let sampleDir: string | undefined;
  let configPath: string | undefined;
  let now: string | undefined;
  let json = false;
  const seen = new Set<string>();
  while (args.length) {
    const arg = args.shift()!;
    if (seen.has(arg)) throw new Error(`参数重复：${arg}`);
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    if (arg === '--unlinked' && command === 'feedback') { if (seen.has('--id')) throw new Error('--unlinked 不能和 --id 同用'); noticeId = null; continue; }
    if (!['--config', '--now', ...(command === 'feedback' ? ['--id'] : []), ...(command === 'evaluate' ? ['--samples'] : [])].includes(arg)) throw new Error(`未知参数：${arg}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    if (arg === '--config') configPath = value;
    else if (arg === '--id') { if (seen.has('--unlinked')) throw new Error('--id 不能和 --unlinked 同用'); noticeId = value; }
    else if (arg === '--samples') sampleDir = value;
    else now = iso(value, '当前时间');
  }
  const config = await loadConfig(configPath);
  if (command === 'feedback') {
    const message = await receiveFeedback(config.dataDir, 'local', { noticeId, content: feedbackWords.join(' '), at: now ?? new Date().toISOString() });
    console.log(json ? JSON.stringify({ message }) : message);
    return;
  }
  if (command === 'evaluate') {
    if (!sampleDir) throw new Error('评测必须指定 --samples <样本目录>');
    const result = await evaluate(config, sampleDir, now);
    console.log(json ? JSON.stringify(result, null, 2) : `共 ${result.total} 份样本\n是/否：判对 ${result.binary.correct} 份，失败 ${result.binary.failed} 份\n高/中/低：判对 ${result.confidence.correct} 份，失败 ${result.confidence.failed} 份\n只记录，不设通过线。`);
    return;
  }
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
