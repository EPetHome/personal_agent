import { detect, overview, rebuild } from '../core/agent.ts';
import { restoreEventLog } from '../core/event-archive.ts';
import { withStoreLock } from '../core/store.ts';
import { loadConfig } from '../core/config.ts';
import { renderOverview } from '../core/judge.ts';
import { receiveFeedback } from '../core/feedback.ts';
import { evaluate } from '../core/evaluate.ts';
import { renderStatistics, statistics } from '../core/statistics.ts';
import { changeExperience, exportExperiences, layers, readLearning } from '../core/learning.ts';
import type { Layer, MemoryStatus } from '../core/learning.ts';
import { feishuChannel } from '../channels/feishu/index.ts';
import { runService } from '../service/daemon.ts';
import { installService, uninstallService } from '../service/launchd.ts';
import { errorMessage, iso } from '../core/utils.ts';

const help = `personal agent（只读盯防、可选模型与渠道）
用法：node code/src/cli/main.ts <detect|overview|rebuild|stats|feishu-poll|daemon> --config <绝对路径.json> [--now <ISO时间>] [--json]
      node code/src/cli/main.ts feedback <正确|误报|漏了|看不懂> [说明] --config <配置> [--id <提醒编号>|--unlinked] [--now <ISO时间>]
      node code/src/cli/main.ts restore-events --output <新的绝对文件路径> --config <配置>
      node code/src/cli/main.ts evaluate --samples <样本目录> --config <配置> [--json]
      node code/src/cli/main.ts experience <list|export|confirm|revise|obsolete|revoke> [经验编号] --config <配置> [--countermeasure <对策>] [--layer <归因层>] [--reason <依据>] [--note <说明>] [--json]
      node code/src/cli/main.ts service-install --target <绝对目标目录> --config <绝对配置> [--activate] [--launchctl <可执行文件>]
      node code/src/cli/main.ts service-uninstall --target <绝对目标目录> --config <配置> [--launchctl <可执行文件>]
  detect    检测一轮、读取假飞书收件、生成到期小结与复盘
  overview / rebuild  只从事件查询/重建，不读来源、不发提醒
  stats     从发件与反馈现算最近七天统计，不另存
  daemon    前台常驻（默认每分钟检测），Ctrl-C 正常退出；不自行安装 launchd
  service-install 默认只生成 plist；--activate 才执行 launchctl
来源和数据目录没有默认值；使用说明见 code/使用说明.md。`;
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') { console.log(help); return; }
  const command = args.shift();
  if (!['detect', 'overview', 'rebuild', 'feedback', 'evaluate', 'stats', 'feishu-poll', 'daemon', 'experience', 'service-install', 'service-uninstall', 'restore-events'].includes(command ?? '')) throw new Error(help);
  const words: string[] = [];
  if (command === 'feedback' || command === 'experience') while (args[0] && !args[0].startsWith('--')) words.push(args.shift()!);
  let noticeId: string | null | undefined;
  let sampleDir: string | undefined, configPath: string | undefined, now: string | undefined, target: string | undefined, launchctl: string | undefined, output: string | undefined;
  let json = false, activate = false;
  const changes: Partial<Record<'layer' | 'countermeasure' | 'reason' | 'note', string>> = {};
  const seen = new Set<string>();
  const serviceCommand = command === 'service-install' || command === 'service-uninstall';
  while (args.length) {
    const arg = args.shift()!;
    if (seen.has(arg)) throw new Error(`参数重复：${arg}`);
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    if (arg === '--activate' && command === 'service-install') { activate = true; continue; }
    if (arg === '--unlinked' && command === 'feedback') { if (seen.has('--id')) throw new Error('--unlinked 不能和 --id 同用'); noticeId = null; continue; }
    if (!['--config', '--now', ...(command === 'feedback' ? ['--id'] : []), ...(command === 'evaluate' ? ['--samples'] : []), ...(command === 'restore-events' ? ['--output'] : []), ...(serviceCommand ? ['--target', '--launchctl'] : []), ...(command === 'experience' ? ['--countermeasure', '--layer', '--reason', '--note'] : [])].includes(arg)) throw new Error(`未知参数：${arg}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    if (arg === '--config') configPath = value;
    else if (arg === '--id') { if (seen.has('--unlinked')) throw new Error('--id 不能和 --unlinked 同用'); noticeId = value; }
    else if (arg === '--samples') sampleDir = value;
    else if (arg === '--target') target = value;
    else if (arg === '--output') output = value;
    else if (arg === '--launchctl') launchctl = value;
    else if (arg === '--now') now = iso(value, '当前时间');
    else changes[arg.slice(2) as keyof typeof changes] = value;
  }
  const config = await loadConfig(configPath);
  if (command === 'restore-events') {
    if (!output) throw new Error('必须显式指定 --output，且目标文件不能已存在');
    await withStoreLock(config.dataDir, () => restoreEventLog(config.dataDir, output!));
    console.log(json ? JSON.stringify({ output }) : `已从封存文件和活动日志还原完整事件到 ${output}；未覆盖原日志。`); return;
  }
  if (serviceCommand) {
    if (!target) throw new Error('必须显式指定 --target；没有真实 LaunchAgents 默认值');
    if (command === 'service-install') await installService(configPath!, target, activate, launchctl);
    else await uninstallService(configPath!, target, launchctl);
    console.log(command === 'service-install' ? `已安装到 ${target}${activate ? ' 并激活' : '（仅生成配置，未激活）'}` : '已卸载，保留其他原有文件'); return;
  }
  if (command === 'daemon') {
    if (now || json) throw new Error('常驻使用系统时间，不接受 --now 或 --json');
    const controller = new AbortController(), stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await runService(config, controller.signal); } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  if (command === 'stats') {
    const result = await statistics(config.dataDir, now); console.log(json ? JSON.stringify(result, null, 2) : renderStatistics(result)); return;
  }
  if (command === 'feishu-poll') {
    const count = await feishuChannel(config).drain(now); console.log(json ? JSON.stringify({ processed: count }) : `已处理 ${count} 条渠道事件`); return;
  }
  if (command === 'experience') {
    const action = words[0] ?? 'list';
    if (action === 'export') console.log(await exportExperiences(config.dataDir));
    else if (action === 'list') {
      const state = await readLearning(config.dataDir);
      console.log(json ? JSON.stringify({ experiences: [...state.experiences.values()], problems: state.problems }, null, 2) : [...state.experiences.values()].map(e => `${e.type} · ${e.tool} · ${e.status} · ${e.layer} · ${e.countermeasure || '对策待定'}`).join('\n') || '暂无经验；用 --json 查看内部关联键');
    } else {
      const statuses: Record<string, MemoryStatus> = { confirm: '已确认', revise: '待确认', obsolete: '已过时', revoke: '已撤销' };
      if (!statuses[action] || !words[1] || words.length !== 2) throw new Error('经验操作须为 confirm/revise/obsolete/revoke + 经验编号');
      if (changes.layer && !layers.includes(changes.layer as Layer)) throw new Error(`归因层只能选：${layers.join('、')}`);
      await changeExperience(config.dataDir, words[1], statuses[action]!, changes as Parameters<typeof changeExperience>[3], now);
      console.log('已记下');
    }
    return;
  }
  if (command === 'feedback') {
    const message = await receiveFeedback(config.dataDir, 'local', { noticeId, content: words.join(' '), at: now ?? new Date().toISOString() });
    console.log(json ? JSON.stringify({ message }) : message); return;
  }
  if (command === 'evaluate') {
    if (!sampleDir) throw new Error('评测必须指定 --samples <样本目录>');
    const result = await evaluate(config, sampleDir, now);
    console.log(json ? JSON.stringify(result, null, 2) : `共 ${result.total} 份样本\n是/否：判对 ${result.binary.correct} 份，失败 ${result.binary.failed} 份\n高/中/低：判对 ${result.confidence.correct} 份，失败 ${result.confidence.failed} 份\n只记录，不设通过线。`); return;
  }
  const view = command === 'detect' ? await detect(config, now)
    : command === 'rebuild' ? await rebuild(config, now) : await overview(config, now);
  if (json) console.log(JSON.stringify({ at: view.at, records: view.records, health: [...view.projection.health.values()], ...(view.projection.pushMismatches.size ? { pushMismatches: [...view.projection.pushMismatches.values()] } : {}), ...(view.projection.feishuConnection ? { feishuConnection: view.projection.feishuConnection } : {}), ...('noticesAdded' in view ? { noticesAdded: view.noticesAdded } : {}) }, null, 2));
  else {
    if ('noticesAdded' in view) console.log(`检测完成，新增 ${view.noticesAdded} 条发件记录。`);
    if (command === 'rebuild') console.log('已从 events.jsonl 重建 state.json。');
    console.log(renderOverview(view.records, view.projection));
  }
}
main().catch(error => { console.error(`错误：${errorMessage(error)}`); process.exitCode = 1; });
