import { basename } from 'node:path';
import { emptyRecord, iso, requiredString } from '../../core/utils.ts';
import type { SourceComponent } from '../../core/types.ts';

export const loop: SourceComponent = {
  tool: 'loop', extension: '.md',
  parse(text, original) {
    // 已知总表/说明不是某次运行；其余总结损坏时不能静默忽略。
    if (['交付记录.md', 'README.md', '说明.md'].includes(basename(original.path))) return null;
    if (!/^#\s+自动评审总结/m.test(text) && !/^- 状态[：:]/m.test(text)) throw new Error('无法识别 loop 总结格式');
    const project = requiredString(text.match(/^- 项目[：:]\s*(.+)$/m)?.[1]?.trim(), 'loop 总结的「- 项目：」');
    const conclusion = requiredString(text.match(/^- 状态[：:]\s*(.+)$/m)?.[1]?.trim(), 'loop 状态');
    const status = conclusion.startsWith('暂停') ? '暂停' : conclusion === '完成' ? '完成' : conclusion === '进行中' ? '进行中' : null;
    if (!status) throw new Error('无法识别 loop 状态');
    const sessionId = text.match(/^- 开发会话[：:]\s*(\S+)/m)?.[1] ?? basename(original.path, '.md');
    const rounds = [...text.matchAll(/### 第\s*\d+\s*轮[（(](\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/g)];
    const lastRound = rounds.at(-1);
    // 不使用文件 mtime（复制样本后会变化）。没有轮次时间的总结，明确报无法推断活动时间。
    if (!lastRound) throw new Error('loop 总结缺少轮次时间');
    const at = iso(`${lastRound[1]}T${lastRound[2]}Z`);
    const record = emptyRecord('loop', sessionId, project, at, original);
    const needsBlock = text.match(/^## 需要你做的事[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? '';
    const needs = needsBlock.split('\n').map(line => line.replace(/^[-*]\s*/, '').trim()).filter(line => line && line !== '无');
    const counts = text.match(/评审\s*(\d+)\s*次[，,、\s]*返修\s*(\d+)\s*次/);
    if (!counts) throw new Error('loop 总结缺少评审/返修次数');
    record.type = 'loop_run';
    record.loop = { status, conclusion, reviews: Number(counts[1]), repairs: Number(counts[2]), needs };
    record.assistantFinished = status === '完成';
    record.recentSteps = [{ at, text: `状态：${conclusion}` }, ...needs.map(text => ({ at, text }))];
    return record;
  },
};
