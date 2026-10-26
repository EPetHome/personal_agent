#!/usr/bin/env bash
set -euo pipefail
CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CODE_DIR"
node --input-type=module -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error("需要 Node.js >=22.19");
  const fs = await import("node:fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (Object.keys(p.dependencies ?? {}).length) throw new Error("本批禁止第三方运行依赖");
'
bash -n deploy/check.sh
if [[ ! -f node_modules/typescript/bin/tsc || ! -f node_modules/@types/node/package.json ]]; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
# 两批场景各用独立开关，均原样传给测试进程；非空配置无效时直接失败，不能静默跳过。
for name in PA_SAMPLE_ROOT PA_SAMPLE_ROOT_V2; do
  root="${!name:-}"
  if [[ -n "$root" ]]; then
    if [[ ! -d "$root" || ! -f "$root/README.md" ]]; then
      printf '%s 不是有效样本根目录：%s\n' "$name" "$root" >&2
      exit 1
    fi
    printf '启用场景：%s=%s\n' "$name" "$root"
  else
    printf '未配置 %s，对应外部场景将明确跳过，不代表通过。\n' "$name"
  fi
done
npm run typecheck
npm test
