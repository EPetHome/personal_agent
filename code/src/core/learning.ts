// 仅保留旧经验的显式查询、导出与旧反馈按钮；不再收集、归因、生成复盘或调用模型。
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withNamedLock } from './locks.ts';
import { appendJsonl, readJsonl } from './store.ts';
import { hash, iso, truncateText } from './utils.ts';
import { noticeSections, presentNotice } from './notice-text.ts';
import { renderNotice } from './judge.ts';
import type { Feedback, Notice, ReviewItem } from './types.ts';

export const layers = ['意图没说清', 'AI 执行偏了', '工具与环境', '盯防自身', '归因未定'] as const;
export type Layer = typeof layers[number];
export const memoryStatuses = ['待确认', '已确认', '已过时', '已撤销'] as const;
export type MemoryStatus = typeof memoryStatuses[number];
export interface Problem {
  id: string; source: string; at: string; type: string; tool: string; project: string | null;
  fact: string; locations: string[]; layer: Layer; reason: string; countermeasure: string; experienceId: string;
  returnCommand?: string; sameReason?: string; noticeKind?: Notice['kind']; card?: Feedback['card']; originalText?: string;
  loop?: { batch: string; repairs: number; reviews: number };
}
export interface Experience {
  id: string; type: string; tool: string; project: string | null; layer: Layer; reason: string; countermeasure: string;
  status: MemoryStatus; sources: string[]; createdAt: string; updatedAt: string; lastUsedAt: string; note: string; reviewRevision?: string;
}
export function experienceRevision(experience: Experience): string {
  return hash(JSON.stringify([experience.reviewRevision ?? experience.updatedAt, experience.id, experience.type, experience.tool,
    experience.project, experience.layer, experience.reason, experience.countermeasure, experience.status, experience.note]));
}
export type LearningEvent = { version: 1; at: string } & (
  | { kind: 'problem'; problem: Problem } | { kind: 'experience'; experience: Experience; replyId?: string }
);
export async function readLearning(dataDir: string) {
  const events = await readJsonl<LearningEvent>(join(dataDir, 'learning.jsonl'));
  const problems: Problem[] = [], experiences = new Map<string, Experience>(), seen = new Set<string>();
  for (const row of events) {
    if (row?.version !== 1 || !Number.isFinite(Date.parse(row.at))) throw new Error('learning.jsonl 结构损坏，保留现场');
    if (row.kind === 'problem') {
      const p = row.problem;
      if (!p?.id || !p.source || !p.experienceId || !layers.includes(p.layer) || typeof p.fact !== 'string' || !Number.isFinite(Date.parse(p.at))) throw new Error('问题记录结构损坏，保留现场');
      if (!seen.has(p.id) && !p.type.startsWith('正确')) { problems.push(p); seen.add(p.id); }
    } else if (row.kind === 'experience') {
      const e = row.experience;
      if (!e?.id || !memoryStatuses.includes(e.status) || !layers.includes(e.layer) || !Array.isArray(e.sources) || typeof e.countermeasure !== 'string' || (e.reviewRevision !== undefined && (typeof e.reviewRevision !== 'string' || !e.reviewRevision))) throw new Error('经验记录结构损坏，保留现场');
      if (!e.type.startsWith('正确')) experiences.set(e.id, e);
    } else throw new Error('不支持的经验事件，保留现场');
  }
  return { events, problems, experiences };
}
export async function changeExperience(dataDir: string, id: string, status: MemoryStatus, changes?: Partial<Pick<Experience, 'layer' | 'reason' | 'countermeasure' | 'note'>>, atInput = new Date().toISOString(), replyId?: string, expectedRevision?: string): Promise<'changed' | 'duplicate' | 'stale' | 'inactive'> {
  const at = iso(atInput);
  if (!memoryStatuses.includes(status) || (changes?.layer && !layers.includes(changes.layer))) throw new Error('经验状态或归因层无效');
  if (status === '已撤销' && !changes?.note?.trim()) throw new Error('撤销须说明原因');
  return withNamedLock(dataDir, '.learning.lock', async () => {
    const state = await readLearning(dataDir);
    if (replyId && state.events.some(row => row.kind === 'experience' && row.replyId === replyId)) return 'duplicate';
    const previous = state.experiences.get(id);
    if (!previous) throw new Error('未找到经验');
    if (replyId && ['已过时', '已撤销'].includes(previous.status)) return 'inactive';
    if ((replyId && !expectedRevision) || (expectedRevision !== undefined && experienceRevision(previous) !== expectedRevision)) return 'stale';
    const safeChanges = Object.fromEntries(Object.entries(changes ?? {}).map(([key, value]) => [key, truncateText(value, 2000)]));
    const experience: Experience = { ...previous, ...safeChanges, status, updatedAt: at, reviewRevision: randomUUID() };
    await appendJsonl(join(dataDir, 'learning.jsonl'), [{ version: 1, at, kind: 'experience', experience, ...(replyId ? { replyId } : {}) }]);
    return 'changed';
  });
}
/** 通用旧卡片构造器；检测入口仅允许 PA 故障类进入发件。 */
export function agentNotice(kind: 'weekly' | 'recurrence' | 'service_restart' | 'daily', key: string, at: string, title: string, summary: string, command: string, reviews?: ReviewItem[]): Notice {
  const raw = { title, summary, returnCommand: command, evidence: { project: null, intentOriginal: null, additionalRequirements: [], recentSteps: [], reason: summary, originals: [] } };
  const sections = noticeSections(raw), content = presentNotice(raw, sections.situation, sections.action, at);
  return { version: 1, id: hash(key), dedupeKey: key, at, tool: 'agent', kind, level: '有空看', content,
    text: renderNotice(content, at), ...(reviews ? { reviews } : {}) };
}
export async function exportExperiences(dataDir: string): Promise<string> {
  const state = await readLearning(dataDir);
  return ['# 经验集', ...[...state.experiences.values()].map(e => [
    `## ${e.type} · ${e.tool} · ${e.project ?? '未关联项目'}`, `状态：${e.status}；归因：${e.layer}`, `依据：${e.reason}`, `对策：${e.countermeasure || '待起草'}`, `备注：${e.note || '无'}`,
    `记下：${e.createdAt}；修改：${e.updatedAt}；最后使用：${e.lastUsedAt}`, '来源：', ...e.sources.map(s => `- ${s}`),
    ...state.problems.filter(p => p.experienceId === e.id).map(p => `- ${p.at} ${p.fact}\n  位置：${p.locations.join('；') || '反馈记录'}`),
  ].join('\n')), ''].join('\n\n');
}
