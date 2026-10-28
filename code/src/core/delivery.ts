import { isFeedbackSuppressed } from './feedback.ts';
import { OperationFailure, safeProcessingFailure } from './failures.ts';
import type { Projection } from './types.ts';

export const MAX_CHANNEL_FAILURES = 5;
export function channelName(name: string): string { return name === 'local' ? '本机通知' : name === 'feishu' ? '飞书' : name; }
/** 文本总览、JSON 与可重建状态共用，文件发件成功不冒充外部渠道成功。 */
export function undeliveredNotices(projection: Projection) {
  const notices = new Map(projection.notices.filter(notice => !isFeedbackSuppressed(notice, projection.feedbackSuppressions)).map(notice => [notice.id, notice]));
  return [...projection.channelDeliveries].flatMap(([key, ok]) => {
    const separator = key.indexOf(':'), channel = key.slice(0, separator), notice = notices.get(key.slice(separator + 1));
    if (ok || !notice) return [];
    const state = projection.channelDeliveryStates.get(key), historyUnknown = !state || !!state.historyUnknown;
    return [{ noticeId: notice.id, title: notice.content.title, channel, failures: historyUnknown ? null : state.failures,
      stopped: historyUnknown || state.failures >= MAX_CHANNEL_FAILURES, ...(historyUnknown ? { historyUnknown: true } : {}),
      failure: historyUnknown ? safeProcessingFailure(new OperationFailure('delivery_history_unknown', ''))
        : state.failure ?? safeProcessingFailure(new OperationFailure(state.failures ? 'legacy_unknown' : 'channel_pending', '')) }];
  });
}
