#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# Lockfile-only install; no production credentials or service endpoints are used by tests.
npm ci --no-audit --no-fund
npm run typecheck
npm test
