// 只有替身loop可调用此模块。真实推送严格限制到同一临时演示根内的本机裸仓库。
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validBatchBranch } from '../src/core/guard.ts';
import type { ExecutionRequest, WorkerReceipt } from '../src/core/managed-types.ts';

export async function executeStub(dir: string, input: ExecutionRequest, settings: Record<string, any>): Promise<WorkerReceipt> {
  const blocked = (code: string, reason: string): WorkerReceipt => ({ requestId: input.requestId, status: 'failed', outcome: 'blocked', code, reason });
  if (!settings.allowExecution || !Array.isArray(settings.projects) || !settings.projects.includes(input.project)) return blocked('scope', '替身未被显式允许操作这个测试项目');
  const root = await realpath(dirname(dir)), project = await realpath(input.project);
  const inside = (path: string) => { const diff = relative(root, path); return !!diff && diff !== '..' && !diff.startsWith('../') && !isAbsolute(diff); };
  if (project !== input.project || !inside(project)) return blocked('scope', '只允许同一临时根内的测试项目');
  if (!['push', 'merge', 'stop'].includes(input.action) || input.source !== 'user_via_pa' || input.force !== false || input.checkSecrets !== true)
    return blocked('policy', '缺少禁止强推/必须扫描密钥的执行前提');
  if (input.action === 'stop') return { requestId: input.requestId, status: 'consumed', outcome: 'stopped', ...(settings.stopCommit ? { commit: settings.stopCommit } : {}) };
  if (!input.branch || !validBatchBranch(input.branch) || !/^[a-f0-9]{40,64}$/i.test(input.commit ?? '')) return blocked('protected_branch', '不是明确的批次分支/完整提交，禁止推main');
  if (input.candidateRef !== undefined) {
    if (input.action !== 'merge') return blocked('candidate_not_pushable', '候选只允许合入，不能推送');
    const allowed = settings.candidateRefs ?? ['refs/pa/candidate', 'refs/loop/candidate'];
    if (!Array.isArray(allowed) || !allowed.includes(input.candidateRef) || !/^refs\/[A-Za-z0-9_./-]+$/.test(input.candidateRef) || input.candidateRef.includes('..'))
      return blocked('candidate_not_allowed', '候选ref不在执行端白名单，未执行');
    const currentCandidate = settings.status?.candidateRef ?? settings.status?.queue?.candidateRef ?? settings.candidateRef;
    if (currentCandidate !== undefined && currentCandidate !== input.candidateRef) return blocked('target_changed', '执行端当前候选ref已变化，未执行');
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' } });
    if (result.status !== 0) throw new Error('测试Git操作失败（不输出原内容）');
    return result.stdout;
  };
  const branch = input.branch.replace(/^refs\/heads\//, ''), ref = `refs/heads/${branch}`;
  try {
    // 只核对本人批准的这一条身份：候选合入不要求尚未更新/尚不存在的批次分支包含它。
    // 不在分支不符时猜别的候选，也不把祖先可达当作精确执行头一致。
    const sourceRef = input.candidateRef ?? ref, sourceName = input.candidateRef ? '候选ref' : '批次分支头';
    let head: string;
    try { head = git('rev-parse', '--verify', `${sourceRef}^{commit}`).trim(); }
    catch { return blocked('target_changed', `${sourceName}不存在，未执行`); }
    if (head !== input.commit) return blocked('target_changed', `${sourceName}已变化，未执行`);
    if (input.action === 'merge') return { requestId: input.requestId, status: 'consumed', outcome: 'merged', commit: settings.mergeCommit ?? input.commit };
    if (!input.remote || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(input.remote)) return blocked('remote', '测试远端名不合法');
    if (settings.pushTarget?.remote !== input.remote || settings.pushTarget?.visibility !== input.visibility) return blocked('target_changed', '远端/公开状态已变化，重新确认');
    const urls = git('remote', 'get-url', '--push', '--all', input.remote).trim().split('\n');
    if (urls.length !== 1 || !isAbsolute(urls[0]!)) return blocked('remote', '替身只允许一个本机裸仓库，不连接网络');
    const remote = await realpath(urls[0]!);
    if (!inside(remote) || remote === project || !(await lstat(join(remote, 'HEAD'))).isFile() || !(await lstat(join(remote, 'objects'))).isDirectory()) return blocked('remote', '远端不在临时测试根内或不是裸仓库');
    const bare = spawnSync('git', ['--git-dir', remote, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8', timeout: 5000 });
    if (bare.status !== 0 || bare.stdout.trim() !== 'true') return blocked('remote', '不是本机裸仓库');
    // 扫描将发送的每条提交补丁（包括后来删掉的密钥），以及暂存、工作区、未跟踪改动。
    const base = git('merge-base', 'refs/heads/main', ref).trim();
    const names = [...git('log', '--format=', '--name-only', `${base}..${input.commit}`).split('\n'), ...git('diff', '--name-only', base, ref).split('\n'), ...git('diff', '--name-only', 'HEAD').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean);
    if (names.some(path => /(?:^|\/)(?:\.env(?:\.(?!example$|sample$).*)?|id_rsa.*|id_ed25519.*)$|\.(?:pem|key|p12|pfx|kdbx)$/i.test(path))) return blocked('suspected_secret', '发现疑似密钥，没推');
    let material = git('log', '--format=', '-p', `${base}..${input.commit}`) + git('diff', 'HEAD');
    for (const path of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
      const full = resolve(project, path), stat = await lstat(full);
      if (relative(project, full).startsWith('..') || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) return blocked('scan_incomplete', '未跟踪改动不能完整安全扫描，未推送');
      const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { material += await file.readFile('utf8'); } finally { await file.close(); }
      if (material.length > 2 * 1024 * 1024) return blocked('scan_incomplete', '改动超过扫描上限，未推送');
    }
    if (/^Binary files |^GIT binary patch/m.test(material)) return blocked('scan_incomplete', '存在无法完整扫描的二进制改动，没推');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|secret|password)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_+\/-]{12,}/i.test(material))
      return blocked('suspected_secret', '发现疑似密钥，没推');
    // 分支头与扫描对象最后再核对，推送固定hash到固定分支；没有force/加号、从不推main。
    if (git('rev-parse', '--verify', ref).trim() !== input.commit) return blocked('target_changed', '扫描后分支头变化，未推送');
    git('push', '--no-verify', input.remote, `${input.commit}:${ref}`);
    return { requestId: input.requestId, status: 'consumed', outcome: 'pushed', commit: input.commit };
  } catch { return blocked('scan_or_git_failed', '测试仓库核实、密钥扫描或Git拒绝，没推；不输出原内容'); }
}
