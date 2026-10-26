# 项目方法（只写一份）

这里放每批复用的检查方法，进仓库；批次目录只放 `批次.json` 和 `结果.md`。字段和环境变量看 loop 的 `工具清单.md`。

- `gate.sh`：门禁（`gate.cmd`）。启用全部已归档的场景样本，再执行 `code/deploy/check.sh`（类型检查和全部测试）。新批次加了样本目录，在 `gate.sh` 的 `SAMPLES` 和 `self-check.sh` 里各补一行。
- `self-check.sh`：方法自测（`methods.selfCheck`）。`bin/loop 开工` 在方法指纹变化时执行一次。
- 没有 `prepare.sh`：本项目是命令行项目，没有要起的服务或测试库。

场景样本只放编的或脱敏的数据；开发、门禁、自动验收都不读真实会话目录。
