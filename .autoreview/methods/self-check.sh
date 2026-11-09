#!/bin/sh
# 只检查新版 PA 的准备方法与运行时前置条件，不运行产品测试。
set -eu

for file in code/agent/package.json code/agent/package-lock.json code/agent/tsconfig.json; do
  [ -f "$file" ] || { echo "AUTOREVIEW_FAILURE=method 缺少新版 PA 文件：$file" >&2; exit 78; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a!==22||b<19) process.exit(1)' \
  || { echo 'AUTOREVIEW_FAILURE=environment 需要 Node.js 22.19 至 22.x' >&2; exit 75; }
node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("code/agent/package.json","utf8")); JSON.parse(fs.readFileSync("code/agent/package-lock.json","utf8")); if(!p.scripts?.typecheck||!p.scripts?.build) process.exit(1)' \
  || { echo 'AUTOREVIEW_FAILURE=method package/lock 或检查入口无效' >&2; exit 78; }
echo '准备方法自检通过：新版 PA 文件、Node 22.x、typecheck/build 入口；未运行产品测试'
