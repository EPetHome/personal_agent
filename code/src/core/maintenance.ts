import { agentNotice, collectProblems, learningBaseline, readLearning, reviewItems } from './learning.ts';
import type { ExperienceModel } from './learning.ts';
import { project } from './events.ts';
import { localDate, renderStatistics, statistics, weekStart } from './statistics.ts';
import { readEvents } from './store.ts';
import { firstScreen } from './notice-text.ts';
import { kindNames } from './statistics.ts';
import { toolNames } from './types.ts';
import { renderNotice } from './judge.ts';
import type { Config, Notice } from './types.ts';

/** 本机当地周五 18:00；停机跨过时间点时，在本次运行期内补发一次，不补初次接入前的小结。 */
export function weeklySlot(now: string): Date {
  const slot = new Date(now);
  const daysSinceFriday = (slot.getDay() + 2) % 7;
  slot.setDate(slot.getDate() - daysSinceFriday); slot.setHours(18, 0, 0, 0);
  if (slot.getTime() > Date.parse(now)) slot.setDate(slot.getDate() - 7);
  return slot;
}
export async function maintain(config: Config, now: string, model?: ExperienceModel): Promise<Notice[]> {
  if (config.learning === false || (!config.feishu && !config.learning)) return [];
  const notices = await collectProblems(config, now, model);
  const projection = project(await readEvents(config.dataDir));
  const slot = weeklySlot(now), slotAt = slot.toISOString();
  const key = `weekly:${localDate(slot)}`;
  if (!projection.startedAt || (slotAt < projection.startedAt && localDate(slot) !== localDate(projection.startedAt)) || projection.notices.some(n => n.dedupeKey === key)) return notices;
  const stats = await statistics(config.dataDir, slotAt);
  const learning = await readLearning(config.dataDir);
  const baselineAt = await learningBaseline(config.dataDir);
  const reviewable = learning.problems.filter(p => !baselineAt || p.at > baselineAt);
  const reviewIds = new Set(reviewable.filter(p => p.at >= weekStart(slotAt) && p.at <= slotAt).map(p => p.experienceId));
  const reviews = reviewItems(learning.problems, learning.experiences, weekStart(slotAt), slotAt).filter(r => reviewIds.has(r.experienceId));
  const weekProblems = reviewable.filter(p => p.at >= weekStart(slotAt) && p.at <= slotAt);
  const totals = ['看不懂', '误报', '漏了', 'loop返修'].map(type => ({ type, count: weekProblems.filter(p => p.type === type).length }));
  const groups = new Map<string, number>();
  for (const problem of weekProblems) {
    const label = `${problem.type} · ${toolNames[problem.tool as keyof typeof toolNames] ?? problem.tool} · ${problem.noticeKind ? kindNames[problem.noticeKind] : problem.type === 'loop返修' ? 'loop 返修' : '未指定原因'}`;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  const grouped = (type: string) => [...groups].filter(([label]) => label.startsWith(`${type} ·`)).map(([label, count]) => `${label}：${count} 次`).join('\n') || '无';
  const counts = totals.filter(item => item.count).map(item => `${item.type} ${item.count} 次`).join('；') || '本周暂无新问题';
  const details = `${renderStatistics(stats)}\n\n问题汇总：${counts}\n\n看不懂（单列）\n${grouped('看不懂')}\n\n其他问题（按工具和提醒原因归并）\n${totals.filter(item => item.type !== '看不懂').map(item => grouped(item.type)).filter(text => text !== '无').join('\n') || '无'}\n\n复盘（有对策却又出现的 > 反复出现的 > 新的）\n${reviews.map(r => r.title).join('\n') || '本周暂无新问题记录'}\n归因与对策均须你确认；不自动执行、不改项目规则。`;
  const summary = firstScreen(`本周提醒 ${stats.cells.reduce((n, c) => n + c.sent, 0)} 次；${counts}`,
    reviews.length ? '请有空打开证据看看问题汇总与对策；「同意」只确认经验' : '不用管，只是告诉你');
  const problem = learning.problems.findLast(p => p.returnCommand && reviewIds.has(p.experienceId));
  const notice = agentNotice('weekly', key, now, 'personal agent 的本周盯防小结', summary,
    problem?.returnCommand ?? 'node code/src/cli/main.ts stats --config <你运行时使用的配置文件>', reviews);
  notice.content.evidence.reason = details;
  notice.text = renderNotice(notice.content, now);
  notices.push(notice);
  return notices;
}
