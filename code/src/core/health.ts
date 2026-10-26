import type { HealthReport } from './types.ts';
import { compact } from './utils.ts';

/** 文件失败数量与有限示例；不能把所有坏文件路径塞进每轮状态和提醒。 */
export function unreadable(report: HealthReport, description: string): void {
  report.fileFailures ??= { count: 0, examples: [] };
  report.fileFailures.count++;
  if (report.fileFailures.examples.length < 3) report.fileFailures.examples.push(compact(description, 240));
}
export function coreUnavailable(report: HealthReport): void {
  if (!report.errors.length) report.errors.push('来源的核心信号整体取不到（没有可用会话）');
}
const MIN_PROFILE_FILES = 10;
const RATE_INCREASE = 0.2;
const MIN_EXCESS_SKIPS = 3;
const BASELINE_WEIGHT = 0.2;
/** 无历史/小样本先不报；坏基线不能在持续异常中被自动学成正常。 */
export function skipAnomaly(report: HealthReport, baseline: number | undefined): string | null {
  const stats = report.fileStats;
  if (report.errors.length || !stats || stats.total < MIN_PROFILE_FILES || baseline === undefined) return null;
  const ratio = stats.skipped / stats.total;
  if (ratio - baseline < RATE_INCREASE - 1e-9 || stats.skipped - baseline * stats.total < MIN_EXCESS_SKIPS - 1e-9) return null;
  return `跳过比例明显升高：本轮 ${stats.skipped}/${stats.total}（${(ratio * 100).toFixed(1)}%），健康基线 ${(baseline * 100).toFixed(1)}%；请检查来源格式`;
}
export function learnSkipBaseline(report: HealthReport, previous: number | undefined): number | undefined {
  const stats = report.fileStats;
  if (report.errors.length || !stats || stats.total < MIN_PROFILE_FILES) return previous;
  const ratio = stats.skipped / stats.total;
  return previous === undefined ? ratio : previous * (1 - BASELINE_WEIGHT) + ratio * BASELINE_WEIGHT;
}
