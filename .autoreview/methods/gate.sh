#!/bin/sh
# 门禁：对应 .autoreview.json 的 gate.cmd，由 Loop 在开发目录执行，退出码 0 通过。
# 跑类型检查和全部测试；已归档的场景样本都要启用，不能跳过。
# 新批次加了样本目录，在下面的 SAMPLES 里按 <环境变量>=<目录> 补一行，并同步 self-check.sh。
set -eu
case "${1:-check}" in
  check) ;;
  *) echo "用法：$0 check" >&2; exit 2 ;;
esac

# 样本里的推送事件写着项目根的绝对路径，所以始终读运行版（项目根）里那份只读样本，不读开发空间里的副本。
ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
SAMPLES="PA_SAMPLE_ROOT=docs/batches/闭环1-感知与总览-20261025/samples
PA_SAMPLE_ROOT_V2=docs/batches/真实格式兼容-20261025/samples"

for pair in $SAMPLES; do
  dir=${pair#*=}
  [ -f "$ROOT/$dir/README.md" ] || { echo "AUTOREVIEW_FAILURE=method 场景样本不存在：$dir" >&2; exit 78; }
  export "${pair%%=*}=$ROOT/$dir"
done

bash code/deploy/check.sh

# 新版 PA（LangGraph 重建，2026-11-04）：独立 package 在 code/agent/，由它自己的 check.sh 装依赖、类型检查、跑测试。
# 甲段建立它之前不存在，此时明确打印跳过；建立之后必须通过。
if [ -f code/agent/check.sh ]; then
  bash code/agent/check.sh
else
  echo '未发现 code/agent/check.sh：新版 PA 尚未建立，本次只检查旧版。'
fi
