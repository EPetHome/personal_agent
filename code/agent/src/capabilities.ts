import type { Config } from './types.js';
import { CONFIG_FIELDS } from './config.js';
import { READ_CAPABILITY } from './documents.js';
import { IMAGE_FORMATS } from './image.js';
import { LOOP_DENY, loopScope } from './loop.js';
import { failure } from './errors.js';

/** Derived from the already validated startup snapshot; never reads credentials or hot-loads grants. */
export function capabilities(c: Config, tools: string[]) {
  const facts = {
    source: '本进程已加载并校验的配置快照及已注册工具；修改配置须正常重启，不逐轮热加载权限',
    read: { projects: c.projects.map(p => ({ id: p.id, root: p.root })), inboxes: c.inboxDirs, attachments: c.attachmentDir,
      narrow: c.readAllow, additionalDeny: c.readDeny, blacklist: '内置文件名/原附件名黑名单、秘密正文、PA 数据和凭据配置始终拒读；真实路径核对，黑名单优先',
      evidence: c.projects.map(p => ({ project: p.id, registeredRunDirs: p.loopRunDirs, rule: '只读已登记且归属本项目的证据文件；事件路径不是新授权，不能读取整个目录或全局 Loop 数据根' })) },
    tools, documents: { ...READ_CAPABILITY, maxSourceBytes: Math.min(c.intake.maxFileBytes, READ_CAPABILITY.maxSourceBytes) }, images: IMAGE_FORMATS,
    write: { router: '只写 PA 私有数据；材料产出经原 worker_dispatch 派给 Pi，不能直接任意复制', outputs: { kinds: ['docx-txt', 'image'], directory: '各项目根 PA产出/，须已在 pi.writeDirs 精确启用', otherProject: c.outputs?.otherProject ?? null, other: '仅本人明确仍无项目归属才放 PA产出/other；未答不写、不催第二遍；日期/来源/原名文件名及同名说明', verification: 'pa_output 固定源/目标、只新建；主程序核对实际路径、完整正文/原字节、摘要；部分失败不报齐全' }, projects: c.projects.map(p => ({ id: p.id, writeDirs: p.pi?.writeDirs ?? [], skills: p.pi?.skills ?? {} })) },
    pi: { readTools: ['pa_read', 'pa_ls', 'pa_grep', 'pa_find'], outputTool: '仅获准产出写派工开放 pa_output；不开放 pa_write/pa_edit/任意复制/命令/联网', documentFormats: READ_CAPABILITY.formats, commands: '只读永远不给；技能/写入须另行本人明确确认', network: '同上，默认没有', readPaths: '仅派工参数、只缩小已有范围，不是启动配置扩权键' },
    loop: { configured: !!c.loop.command, independentOfPiWriteDirs: true,
      projects: c.projects.map(p => {
        if (!p.loop) return { id: p.id, dispatch: false };
        try { return { id: p.id, dispatch: true, ...loopScope(p, '<原操作编号>'), rule: '仅配置的 code/ 范围及原批次结果/元数据；其余 docs/ 不在 allow，不能开放整个 docs/；deny 优先' }; }
        catch (error) { return { id: p.id, dispatch: false, configuredAllow: p.loop.allow, deny: [...p.loop.deny, ...LOOP_DENY], ...failure(error) }; }
      }),
      protocol: { dispatch: 'version:1 单任务卡；开发评审/验收；不提交、不推送、不部署', query: 'kernel:1 + 原 ledger 最小字段核对；旧 v1 历史保留', control: '新版按原对象停止；仅冻结流程无发布节点/发布事务/待改卡时可安全续跑；send/合入/推送/部署不可用', verification: 'get_task/worker_status 可查原身份、sourceRevision、lastVerifiedAt、各层欠项；技术状态不是业务验收' },
      sensing: ['有有效事件时可核实旧记录；新版只监听 track_loop/PA 自派已绑定 ledger 的普通修订，事件与查询不一致时不主动通知', '全来源新任务自动发现、长期关注尚未实现；无有效事件时每 60 秒独立核对已托管原执行，等待/排队 5 分钟、终态停止；连续两次查询失败才报状态待核实，保留最后可靠事实，重启去重、恢复更新原卡；明确退出据实报告，身份未知不判失败，不按静默时长判停滞、不自动控制或解除未核实操作占用'] },
    configuration: { fields: Object.fromEntries(Object.entries(CONFIG_FIELDS).map(([key, fields]) => [key, fields.join(' ')])), rules: ['未知/不生效字段拒绝加载', 'projects[].pi.writeDirs 仅项目内部子目录，不能是项目根或项目外目录', 'approval 不改变目录/工具权限；redLine 永远问', 'Loop 不依赖普通 Pi 的写目录', '证据范围只沿用现有登记，不从事件自动扩权'] },
    dispatchCard: { receipt: '可核对原接收后，健康通道 10 秒内发或更新原已派出卡：目标、完成标准、边界、原执行及停止按钮；接收未知不冒称派出，送达未知不重发、不重派',
      stop: '仅本人 P2P 原卡、有效专用令牌和原任务/运行/目标；点击即本次停止指令，按原对象停一次并保留成果；未知不重停，不改变普通聊天 approval.stop 或红线规则' },
    approval: c.approval,
  };
  // Compose only this adapter's facts; retain other capability providers' fields
  // and their no-event monitoring description rather than replacing that block.
  return { ...facts, loop: { ...facts.loop,
    protocol: { ...facts.loop.protocol, verification: 'list_projects/list_tasks/query_loop 分页摘要；get_task/worker_status 先核对原来源再按需读定义与分层事实；read_task_evidence 逐次核权读证据。失败保留 sourceRevision/lastVerifiedAt，技术状态不是业务验收' },
    sensing: ['按获准项目 Git common identity 定位约定运行索引，自动发现 version:1/kernel:1 单/多任务正式记录；PA 自派与本人独立启动分别按原身份跟踪。通知仅唤醒，默认 60 秒兜底，分页续查；只恢复当前事实，不补造丢失过程',
      ...facts.loop.sensing.slice(1).map(text => text.replace('全来源新任务自动发现、长期关注尚未实现；', '未登记 Loop 单会话、独立 Pi、未知协议及完整长期关注管理未接通；'))] } };
}
