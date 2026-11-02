# personal agent 评测集

本批从既有记录收集状态判定与推送决策题；未调用模型、未回放。采集快照对应 18 条反馈、484 张卡片、249 条抑制记录。完整来源、行号、数据文件前缀 SHA-256 和逐题索引在本机 `待标注/采集依据.json`；以后原日志追加不会改变本批分母。

在项目根执行（Node 22.23.1 已核对，无 npm 依赖）：

```sh
cd "/Users/Admin/Desktop/personal agent"
node eval/check.ts
node --test eval/check.test.ts
```

检查仅读取本机评测目录：必填结构、判定点、引用文件、冻结 SHA-256、片段截止时间、18 条反馈登记完整性、对账一卡一事件；失败退出 1。它不验证模型判断是否正确，也不读取源会话或运行服务。Node 可能提示上层 package.json 未声明模块类型，不影响检查；本批不修改上层配置。

真实题目 YAML、会话和卡片附件全部在被忽略的 `cases/`；`runs/`、`待标注/` 同样被忽略。这样满足任务 A6 的三个目录都不进入公开仓库。可纳入版本管理的仅本 README、判定点、检查脚本及只含数字和编号的报告。新检出仓库不会带入真实题目，检查会明确报没有题目。

## 题目清单

| 编号 | 来源 | 类型 | 状态 | 可回放 |
| --- | --- | --- | --- | --- |
| J001 | 线上反馈 | blind | 已标注 | False |
| W001 | 线上反馈 | missed | 待补证 | False |
| J002 | 线上反馈 | blind | 已标注 | False |
| J003 | 线上反馈 | stalled | 已标注 | False |
| J004 | 线上反馈 | loop_completed | 已标注 | False |
| J005 | 线上反馈 | waiting | 已标注 | False |
| J006 | 线上反馈 | waiting | 已标注 | False |
| J007 | 线上反馈 | waiting | 已标注 | False |
| J008 | 线上反馈 | waiting | 已标注 | False |
| J009 | 线上反馈 | waiting | 已标注 | False |
| J010 | 线上反馈 | waiting | 已标注 | False |
| J011 | 线上反馈 | waiting | 已标注 | False |
| J012 | 线上反馈 | waiting | 已标注 | False |
| J013 | 线上反馈 | stalled | 已标注 | True |
| J014 | 线上反馈 | loop_completed | 已标注 | False |
| J015 | 线上反馈 | drift | 已标注 | False |
| J016 | 线上反馈 | stalled | 待标注 | False |
| J017 | 线上反馈 | unreadable | 待标注 | False |
| J018 | 线上反馈 | waiting | 待标注 | False |
| J019 | 线上反馈 | blind | 待标注 | False |
| J020 | 线上反馈 | stalled | 待标注 | False |
| J021 | 线上反馈 | stalled | 待标注 | False |
| J022 | 线上反馈 | recurrence | 待标注 | False |
| J023 | 线上反馈 | recurrence | 待标注 | False |
| J024 | 线上反馈 | recurrence | 待标注 | False |
| J025 | 线上反馈 | recurrence | 待标注 | False |
| J026 | 线上反馈 | recurrence | 待标注 | False |
| J027 | 线上反馈 | stalled | 待标注 | False |
| J028 | 线上反馈 | recurrence | 待标注 | False |
| J029 | 线上反馈 | recurrence | 待标注 | False |
| J030 | 线上反馈 | recurrence | 待标注 | False |
| J031 | 线上反馈 | stalled | 待标注 | False |
| J032 | 线上反馈 | stalled | 待标注 | False |
| J033 | 线上反馈 | stalled | 待标注 | True |
| J034 | 线上反馈 | stalled | 待标注 | False |
| J035 | 线上反馈 | blind | 待标注 | False |
| J036 | 线上反馈 | drift | 待标注 | False |
| J037 | 线上反馈 | recurrence | 待标注 | False |
| J038 | 线上反馈 | stalled | 待标注 | False |
| J039 | 线上反馈 | stalled | 待标注 | False |
| J040 | 线上反馈 | drift | 待标注 | False |
| J041 | 线上反馈 | stalled | 待标注 | False |
| J042 | 线上反馈 | drift | 待标注 | False |
| J043 | 线上反馈 | waiting | 待标注 | False |
| J044 | 线上反馈 | loop_paused | 待标注 | False |
| J045 | 线上反馈 | drift | 待标注 | False |
| J046 | 线上反馈 | drift | 待标注 | False |
| J047 | 线上反馈 | stalled | 待标注 | False |
| J048 | 线上反馈 | unreadable | 待标注 | False |
| J049 | 线上反馈 | waiting | 待标注 | False |
| J050 | 线上反馈 | unreadable | 待标注 | False |
| J051 | 线上反馈 | weekly | 待标注 | False |
| J052 | 线上反馈 | stalled | 待标注 | False |
| J053 | 线上反馈 | drift | 待标注 | False |
| J054 | 线上反馈 | loop_completed | 待标注 | False |
| J055 | 线上反馈 | stalled | 待标注 | False |
| J056 | 事故 | blind | 待补证 | False |
| J057 | 事故 | stalled | 待补证 | False |
| J058 | 事故 | waiting | 待补证 | False |
| J059 | 事故 | recurrence | 待补证 | False |
| J060 | 事故 | recurrence | 待补证 | False |
| W002 | 事故 | missed | 待补证 | False |
| J061 | 事故 | loop_paused | 待补证 | False |
| J062 | 事故 | waiting | 待补证 | False |
| J063 | 事故 | waiting | 待补证 | False |
| W003 | 事故 | missed | 待补证 | False |
| J064 | 事故 | blind | 待补证 | False |
| J065 | 事故 | blind | 待补证 | False |
| J066 | 事故 | completed | 待补证 | False |
| W004 | 漏网 | loop_paused | 待补证 | False |
| W005 | 漏网 | loop_paused | 待补证 | False |
| W006 | 漏网 | loop_paused | 待补证 | False |
| W007 | 漏网 | loop_paused | 待补证 | False |
| W008 | 漏网 | loop_paused | 待补证 | False |
| W009 | 漏网 | loop_paused | 待补证 | False |
| W010 | 漏网 | loop_paused | 待补证 | False |
| W012 | 漏网 | loop_paused | 待补证 | False |
| W013 | 漏网 | loop_paused | 待补证 | False |
| W014 | 漏网 | loop_paused | 待补证 | False |

W011 和 L017 为准备时识别出的重复参照，已并入 L016 对应事件，编号空缺保留；不重排其他题号。W 题中的“待补证”不等于已确认漏报。

## 使用与补标

`待标注/2026-10-31.md` 每张卡一行，最后一栏填“正确 / 误报 / 看不懂”。未填不能算正确。18 条原始反馈全部保留，同卡重复反馈只形成一道题，先后意见不覆盖原件；状态统计使用最后一条正确/误报，单列冲突，可读性反馈另记。本批不会自动导入新标注或重算模型成绩。

事故题指向原问题单并记录候选卡片是否唯一；历史 46 个会话只有汇总，保留一题待补会话编号。按原件来源、同会话身份、类型和时间做 Loop 对账；缺暂停时间不能用文件修改时间代替。私有 `Loop对账.md` 与 `抑制清单.md` 可逐项追溯，公开报告只保留编号及统计。

每题附件 `冻结清单.json` 记相对文件、SHA-256、原路径、原行号范围；多段行号表示跳过了晚于 evidenceAt、无时间或敏感标记行。敏感行整行不保存，缺输入就标不可回放。Loop 原总结可被覆盖，当前文件不冒充当时版本。冻结记录是观测证据，不是本批新运行的 trace 或判定。

`初始环境.可回放` 只描述可否重建证据输入；旧模型、旧提示词没有日志时为 null，不补猜。可推定的运行代码版本附基线与服务启停依据，仍区别于逐次哈希证明。首批不创建假的运行产物，`runs/` 留空，`报告/成绩单.md` 不填伪运行成绩。未来模型回放必须单独获授权并设调用上限。

## 统一结构（沿用任务原文）

（两个项目逐字一致，不得改字段名和层级）

```
<评测根>/                      本项目为 eval/
├─ README.md                   做法、规矩、题目清单；本节结构说明写进这里
├─ 判定点.md                   跨题共用的判定点（本项目：状态判定、推送决策、卡片的判定点和过程断言）
├─ cases/
│   ├─ <id>.yaml               一道题
│   └─ <id>/                   这道题的原件、附件、工具 mock（可选）
├─ runs/<日期>/<id>/
│   ├─ 产物.md                 被测这次的输出；多个文件时放 产物/ 目录
│   ├─ trace.jsonl             这次的轨迹，一行一步
│   └─ 判定.json               逐条判定点的结果和理由
└─ 报告/
    ├─ 成绩单.md               一次运行一行的汇总表
    └─ <日期>.md               需要时写的阶段报告
```

`<id>` 沿用各项目现有编号（本项目新编：J001 起为状态判定题，W001 起为漏报题），不重新编号。`<日期>` 写成 `YYYY-MM-DD`，同一天跑多次时加后缀，如 `2026-10-31-2`。

题目文件 `cases/<id>.yaml`：

```yaml
id: Q01
标题: 平台调研／学习借鉴
来源: 线上反馈 FB-01            # 线上反馈 / 事故 / 漏网 / 手造 / 干净
层: 能力                         # 能力 / 回归
状态: 草稿                       # 沿用项目自己的状态词
失败类别: []                     # 归类名；还没有就留空
被测对象: 产品智能体

题目:
  原文: cases/Q01/题目.md        # 原话很长或有格式时引用文件；短的可以直接写在这里
  附件: []                       # 相对路径或链接；缺原件时写明

初始环境:                        # 回放时必须能还原的东西
  版本: null
  模型: null
  可回放: false
  不可回放原因: null
  其他: {}                       # 各项目自己填，如附件版本、专家缓存、外部网站日期

结果判定:
  - 判定点: T1                   # 引用 判定点.md 的编号
    类型: 底线                   # 底线 / 质量 / 成本 / 风格
    本题判法: ""
  - 判定点: S1                   # 本题独有的判定点直接写在这里
    类型: 质量
    条款: ""
    本题判法: ""
    为什么只属于本题: ""

参考案例:
  - id: C1
    出处: ""
    评价: ""                     # 好 / 坏，加上反馈人原话摘录

过程断言:                        # 可以为空
  必须: []
  绝不: []
  顺序: []
  步数上限: null

关键决策点: []                   # 可以为空；只给权重高的题写

证据: []
扩展: {}                         # 项目自有字段，如 风格项、跑法、模拟用户人设卡
修订:
  - 版本: v1
    日期: 2026-10-30
    内容: ""
```

YAML 只用以下子集，方便两边都用零依赖程序读取：块风格的映射和列表；单行标量（字符串、数字、`true`/`false`、`null`）；多行文本用 `|`；空值写 `[]`、`{}` 或 `null`。不用锚点、引用、流式多行、多文档。

`trace.jsonl` 每行一个 JSON 对象，至少包括：`step`（从 1 开始）、`轮次`、`角色`（用户 / 主理人 / 成员名 / 模拟用户 / 程序）、`动作`（发言 / 工具调用 / 派发 / 交接 / 等待）、`工具`、`摘要`、`开始`、`结束`、`token`、`来源`（原始记录的文件路径和行号）。拿不到的字段写 `null`，不估算。

`判定.json` 至少包括：`caseId`、运行日期、版本、模型、打分方式（人 / 评委，是否盲打）、指标版本，以及 `结果`。`结果` 是一个列表，每项包括 `判定点`、`结论`（有 / 没有 / 不适用 / 数值）、`理由`。


