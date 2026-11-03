import type { Notice, Projection } from './types.ts';

export const WAITING_INTERVAL_MS = 5 * 60 * 1000;
/** 保留原渠道约定：紧急本机和飞书，有空看只发飞书；已选出口不重算。 */
export function routeNotice(notice: Notice, _projection: Projection, now: string): Notice {
  if (notice.delivery) return notice;
  return { ...notice, delivery: { presence: '不在场', channels: notice.level === '有空看' ? ['feishu'] : ['local', 'feishu'], decidedAt: now } };
}
