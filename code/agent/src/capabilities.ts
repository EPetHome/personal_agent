import type { Config } from './types.js';
import { CONFIG_FIELDS } from './config.js';
import { READ_CAPABILITY } from './documents.js';
import { IMAGE_FORMATS } from './image.js';
import { LOOP_DENY, loopScope } from './loop.js';
import { failure } from './errors.js';

/** Derived from the already validated startup snapshot; never reads credentials or hot-loads grants. */
export function capabilities(c: Config, tools: string[]) {
  return {
    source: '本进程已加载并校验的配置快照及已注册工具；修改配置须正常重启，不逐轮热加载权限',
    read: { projects: c.projects.map(p => ({ id: p.id, root: p.root })), inboxes: c.inboxDirs, attachments: c.attachmentDir,
      narrow: c.readAllow, additionalDeny: c.readDeny, blacklist: '内置文件名/原附件名黑名单、秘密正文、PA 数据和凭据配置始终拒读；真实路径核对，黑名单优先',
      evidence: c.projects.map(p => ({ project: p.id, registeredRunDirs: p.loopRunDirs, rule: '只读已登记且归属本项目的证据文件；事件路径不是新授权，不能读取整个目录或全局 Loop 数据根' })) },
    tools, documents: { ...READ_CAPABILITY, maxSourceBytes: Math.min(c.intake.maxFileBytes, READ_CAPABILITY.maxSourceBytes) }, images: IMAGE_FORMATS,
    write: { router: '只写 PA 私有数据；没有材料另存/复制/TXT 产物入口', projects: c.projects.map(p => ({ id: p.id, writeDirs: p.pi?.writeDirs ?? [], skills: p.pi?.skills ?? {} })) },
    pi: { readTools: ['pa_read', 'pa_ls', 'pa_grep', 'pa_find'], documentFormats: READ_CAPABILITY.formats, commands: '只读永远不给；技能/写入须另行本人明确确认', network: '同上，默认没有', readPaths: '仅派工参数、只缩小已有范围，不是启动配置扩权键' },
    loop: { configured: !!c.loop.command, independentOfPiWriteDirs: true,
      projects: c.projects.map(p => {
        if (!p.loop) return { id: p.id, dispatch: false };
        try { return { id: p.id, dispatch: true, ...loopScope(p, '<原操作编号>'), rule: '仅配置的 code/ 范围及原批次结果/元数据；其余 docs/ 不在 allow，不能开放整个 docs/；deny 优先' }; }
        catch (error) { return { id: p.id, dispatch: false, configuredAllow: p.loop.allow, deny: [...p.loop.deny, ...LOOP_DENY], ...failure(error) }; }
      }),
      sensing: ['有有效事件时可核实暂停、失败、恢复和完成；事件与查询状态不一致时只记日志，不主动通知', '无有效事件时，尚无独立发现外部 Loop 进程消失或长期无进展的检测'] },
    configuration: { fields: Object.fromEntries(Object.entries(CONFIG_FIELDS).map(([key, fields]) => [key, fields.join(' ')])), rules: ['未知/不生效字段拒绝加载', 'projects[].pi.writeDirs 仅项目内部子目录，不能是项目根或项目外目录', 'approval 不改变目录/工具权限；redLine 永远问', 'Loop 不依赖普通 Pi 的写目录', '证据范围只沿用现有登记，不从事件自动扩权'] },
    approval: c.approval,
  };
}
