# 项目准备方法

当前用于新版 PA `code/agent/`；在 Loop 为本任务创建的工作区执行，不在主目录旧源码树执行。

- `self-check.sh` 只检查 package/lock/tsconfig、Node 22.19 至 22.x 和 typecheck/build 入口，不运行类型检查、构建或产品测试。
- `.autoreview.json.preparation.check` 在上述检查后加载 TypeScript 与 SQLite 本地依赖；缺失时只按原 lockfile 执行一次 `npm ci --no-audit --no-fund`，不升级依赖，不启动产品或模型。恢复失败保留原因，不能跳过前置条件。
- 实际产品检查只用新开发卡 `tasks[].test` 的定向原命令；最新 Loop 提供隔离测试目录，不再手写归档/复制副本，不调用全仓 gate。
- 旧 `gate.sh` 保留作历史，不在现有配置或本批检查中执行。没有要启动的真实服务、数据库或账号。

字段、资源、权限及启动写法按本机 Loop 的 `工具清单.md`、`README.md`、`README-验收标准.md`；本文件不复制执行器实现或修改权限保护。
