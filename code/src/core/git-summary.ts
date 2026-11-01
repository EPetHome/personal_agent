import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from './process.ts';

/** 不读仓库配置；只接受当前独立仓库中的普通元数据文件，不跟随链接。 */
async function metadata(gitDir: string, name: string, maximum: number): Promise<Buffer | null> {
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || /[\0\r\n\\]/.test(name)) throw new Error('unsafe metadata path');
  let path = gitDir;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('linked metadata');
    if (index !== parts.length - 1) { if (!stat.isDirectory()) throw new Error('not a directory'); continue; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error('unsafe metadata');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await file.stat();
      if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size > maximum) throw new Error('changed metadata');
      const data = await file.readFile();
      if (data.length > maximum) throw new Error('metadata limit');
      return data;
    } finally { await file.close(); }
  }
  return null;
}
async function headCommit(gitDir: string): Promise<string | null> {
  const head = (await metadata(gitDir, 'HEAD', 4096))?.toString('utf8').trim();
  if (!head) throw new Error('missing HEAD');
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  if (!head.startsWith('ref: refs/')) throw new Error('unsupported HEAD');
  const ref = head.slice(5);
  const loose = await metadata(gitDir, ref, 128);
  if (loose) {
    const oid = loose.toString('utf8').trim();
    if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error('unsupported reference');
    return oid;
  }
  const packed = (await metadata(gitDir, 'packed-refs', 8 * 1024 * 1024))?.toString('utf8') ?? '';
  for (const line of packed.split('\n')) if (line.slice(41) === ref && /^[a-f0-9]{40} /.test(line)) return line.slice(0, 40);
  return null; // 新建、尚无提交的仓库。
}

/**
 * 在本机数据目录内建立私有Git元数据视图，只复制HEAD/索引并引用对象库。
 * 绝不对原仓库执行Git：原config/include/config.worktree、用户/系统配置均不加载，
 * 因而未知名称的clean/process、diff、pager、fsmonitor等也没有执行入口。
 */
export async function readOnlyGitSummary(project: string | null, workDir: string, signal: AbortSignal): Promise<string> {
  if (!project) return '没有可读项目，不取 git';
  let temporary: string | undefined;
  try {
    const gitDir = join(project, '.git');
    for (const path of [gitDir, join(gitDir, 'objects')]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('not an independent repository');
    }
    // 工作树共享目录、替代对象库和浅仓库不能在当前边界内可靠复制，安全降级。
    for (const name of ['commondir', 'objects/info/alternates', 'shallow']) {
      if (await metadata(gitDir, name, 4096) !== null) throw new Error('unsupported shared metadata');
    }
    const head = await headCommit(gitDir), index = await metadata(gitDir, 'index', 16 * 1024 * 1024);
    temporary = await mkdtemp(join(workDir, '.git-summary-'));
    await mkdir(join(temporary, 'refs')); await mkdir(join(temporary, 'objects'));
    await writeFile(join(temporary, 'HEAD'), head ? head + '\n' : 'ref: refs/heads/constructed-empty\n', { mode: 0o600 });
    if (index) await writeFile(join(temporary, 'index'), index, { mode: 0o600 });
    await writeFile(join(temporary, 'config'), '[core]\nrepositoryformatversion=0\nbare=false\nfsmonitor=false\nhooksPath=/dev/null\nattributesFile=/dev/null\n[gc]\nauto=0\n[maintenance]\nauto=false\n[submodule]\nrecurse=false\n', { mode: 0o600 });
    // 不是对继承环境做局部删除：只给Git这份固定白名单，环境注入的配置/trace/exec-path也不可达。
    const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: temporary, XDG_CONFIG_HOME: temporary,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_OBJECT_DIRECTORY: join(gitDir, 'objects'), LC_ALL: 'C' };
    const prefix = ['--no-pager', '--no-optional-locks', `--git-dir=${temporary}`, `--work-tree=${project}`];
    const git = (args: string[]) => runCommand('/usr/bin/git', [...prefix, ...args], 1500, undefined, signal, workDir, environment);
    const status = await git(['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=all']);
    const log = head ? await git(['log', '--no-show-signature', '-5', '--format=%h %s']) : '';
    const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--stat']);
    return JSON.stringify({ status: status.slice(0, 8000), recentCommits: log.slice(0, 4000), diffStat: diff.slice(0, 8000),
      safety: '私有Git元数据视图，未加载仓库/用户配置，未运行外部过滤器；原始工作区差异可能与过滤后的Git输出不同' });
  } catch { return 'git摘要不可用：不能在只读边界内安全读取该仓库（未运行仓库或用户配置中的命令）'; }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
