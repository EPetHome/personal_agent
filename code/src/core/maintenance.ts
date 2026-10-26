import { join } from 'node:path';
import { agentNotice, collectProblems, readLearning, reviewItems } from './learning.ts';
import type { ExperienceModel } from './learning.ts';
import { project } from './events.ts';
import { localDate, renderStatistics, statistics, weekStart } from './statistics.ts';
import { readEvents } from './store.ts';
import { shellQuote } from './utils.ts';
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
  const reviews = reviewItems(learning.problems, learning.experiences, weekStart(slotAt), slotAt);
  const summary = `${renderStatistics(stats)}\n\n复盘（有对策却又出现的 > 反复出现的 > 新的）\n${reviews.map(r => r.title).join('\n') || '本周暂无问题记录'}\n归因与对策均须你确认；不自动执行、不改项目规则。`;
  notices.push(agentNotice('weekly', key, now, '本周盯防小结', summary, `open ${shellQuote(join(config.dataDir, 'learning.jsonl'))}`, reviews));
  return notices;
}
