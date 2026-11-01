import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CodeVersion } from './types.ts';

/** 只查本程序的仓库，不查调用者 cwd；整个进程固定一次，运行时切分支不会冒充新版本。 */
function identify(): CodeVersion {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  // 不继承 GIT_DIR/GIT_WORK_TREE 等覆盖，也不加载个人 Git 配置或凭据。
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return { commit: null, dirty: null };
    const changes = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal', '--', 'code/'],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return { commit, dirty: changes.length > 0 };
  } catch { return { commit: null, dirty: null }; }
}
export const codeVersion: Readonly<CodeVersion> = Object.freeze(identify());
