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
npm run typecheck
npm test
