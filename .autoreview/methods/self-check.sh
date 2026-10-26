#!/bin/sh
# 方法自测：Loop 在方法指纹变化时调用一次；输出 AUTOREVIEW_FAILURE=method 并退出 78 表示方法无效。
set -eu

for file in .autoreview/methods/gate.sh code/deploy/check.sh; do
  [ -f "$file" ] || { echo "AUTOREVIEW_FAILURE=method 缺少方法入口：$file" >&2; exit 78; }
done
sh -n .autoreview/methods/gate.sh || { echo "AUTOREVIEW_FAILURE=method 门禁脚本语法错误" >&2; exit 78; }
bash -n code/deploy/check.sh || { echo "AUTOREVIEW_FAILURE=method check.sh 语法错误" >&2; exit 78; }

for dir in docs/batches/闭环1-感知与总览-20261025/samples docs/batches/真实格式兼容-20261025/samples; do
  [ -f "$dir/README.md" ] || { echo "AUTOREVIEW_FAILURE=method 场景样本不存在：$dir" >&2; exit 78; }
done

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<19)) process.exit(1)' \
  || { echo "AUTOREVIEW_FAILURE=environment 需要 Node.js >=22.19" >&2; exit 75; }

echo '方法自测通过：门禁入口、场景样本、Node 版本都在'
