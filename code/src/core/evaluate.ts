import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { assertRegularFile, validateConfig } from './config.ts';
import { boundedContext, piJudge } from './model.ts';
import { event, project } from './events.ts';
import { appendJsonl, readEvents, withStoreLock } from './store.ts';
import { iso, object, requiredString } from './utils.ts';
import type { Config, Judge, JudgmentRequest } from './types.ts';

export interface Evaluation { total: number; binary: { correct: number; failed: number }; confidence: { correct: number; failed: number }; samples: { file: string; binary?: string; confidence?: string }[] }
/** 仅显式 evaluate 会调当前判断器；无分数通过线。评测用量也计入同一 UTC 日额度。 */
export async function evaluate(configInput: Config, sampleDir: string, now = new Date().toISOString(), injected?: Judge): Promise<Evaluation> {
  const config = await validateConfig(configInput);
  if (!config.judge) throw new Error('评测必须配置 judge');
  const at = iso(now);
  const requests: { file: string; expected: string; request: JudgmentRequest }[] = [];
  for (const file of (await readdir(sampleDir)).filter(f => f.endsWith('.json')).sort()) {
    const path = join(sampleDir, file);
    await assertRegularFile(path);
    const sample = object(JSON.parse(await readFile(path, 'utf8')), '样本');
    if (!['drift', 'waiting'].includes(sample.task) || !['是', '否'].includes(sample.expected) || !Array.isArray(sample.newSteps)
      || !Array.isArray(sample.additionalRequirements ?? [])) throw new Error(`样本格式错误：${file}`);
    const context = boundedContext({ intentOriginal: sample.intentOriginal == null ? null : requiredString(sample.intentOriginal, '意图原文'),
      additionalRequirements: (sample.additionalRequirements ?? []).map((s: unknown) => requiredString(s, '追加要求')),
      previousSummary: sample.previousSummary ?? '', assistantReply: sample.assistantReply ?? '',
      newSteps: sample.newSteps.map((s: unknown) => typeof s === 'string' ? { at, text: s } : { at: iso(object(s).at), text: requiredString(object(s).text, '步骤') }),
    });
    requests.push({ file, expected: sample.expected, request: { task: sample.task, format: 'binary', context } });
  }
  if (!requests.length) throw new Error('样本目录没有 .json 样本');
  return withStoreLock(config.dataDir, async () => {
    const projection = project(await readEvents(config.dataDir));
    const day = at.slice(0, 10);
    let used = projection.modelCalls.get(day) ?? 0;
    const judge = injected ?? piJudge(config.judge!);
    const result: Evaluation = { total: requests.length, binary: { correct: 0, failed: 0 }, confidence: { correct: 0, failed: 0 }, samples: [] };
    for (const sample of requests) {
      const row: Evaluation['samples'][number] = { file: sample.file };
      for (const format of ['binary', 'confidence'] as const) {
        if (used >= config.judge!.dailyLimit) { result[format].failed++; row[format] = '每日额度用完'; continue; }
        await appendJsonl(join(config.dataDir, 'events.jsonl'), [event({ kind: 'model_call_started', task: sample.request.task, key: `evaluation:${sample.file}:${format}` }, at)]);
        used++;
        try {
          const answer = await judge.judge({ ...sample.request, format });
          row[format] = answer.confidence ?? answer.answer;
          if (answer.answer === sample.expected) result[format].correct++;
        } catch { result[format].failed++; row[format] = '调用失败'; }
      }
      result.samples.push(row);
    }
    return result;
  });
}
