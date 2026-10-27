# 卡片「谁」里混入 IDE 自动附带的标签

状态：收集中（2026-10-27 反馈与卡片版上真机后发现），等周末按同源归并排批。同源：根子 A「卡片内容靠规则从对话原文抠」，见[卡片缺这件事是什么](卡片缺这件事是什么.md)末尾。

## 问题与影响

【必须修改】在 VS Code 等编辑器里用 Claude Code 时，编辑器会在用户消息前自动附上「用户打开了哪个文件」这类标签。卡片「谁」把这段标签当成了意图，用户读不出这个会话在干什么。上一批只跳过了图片和附件，这是同一类问题的另一种形态。

## 事实

2026-10-27 06:59（UTC）升级后发出的两张卡片：

```
谁：loop 的 Claude Code：<ideopenedfile>The user opened the file 这个项目相关文件 in the IDE. This may or may not be related to the current task.<相关文件>；【这个项目相关文件，我要codex总结了一…
谁：personal agent 的 Claude Code：<ideopenedfile>The user opened the file 这个项目相关文件 in the IDE. This may or may not be related to the current task.<相关文件>
```

- 原文里是编辑器注入的 `<ide_opened_file>…</ide_opened_file>`（卡片里下划线被吃掉了），同类的还有 `<ide_selection>`、`<system-reminder>` 等。
- 第一张卡片里，真正的意图在标签后面，只露出一个开头。
- 来源：真机 `outbox.jsonl`。

## 分层归因

- 产品实现：意图提取只认图片、附件占位，不认编辑器和系统注入的标签块。
- 验证：会话样本都是在终端里录的，没有在编辑器里用的样本。

## 处理方向

1. 意图（以及助手问题的上下文）跳过编辑器和系统自动注入的标签块，只取用户自己打的字；标签后面有正文就取正文。
2. 用这两种真实形态（只有标签、标签加正文）各补一个脱敏样本。
