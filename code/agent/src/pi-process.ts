import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseJson, sleep } from './util.js';

const exec = promisify(execFile);
export interface ProcessIdentity { pid: number; pgid: number; started: string }
interface ProcessRow extends ProcessIdentity { ppid: number; state: string }
export async function processes(): Promise<ProcessRow[]> {
  const probe = exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
  const observer = probe.child.pid;
  const { stdout } = await probe;
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)/.exec(line);
    return match && Number(match[1]) !== observer ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4]!, state: match[5]! }] : [];
  });
}
export async function identity(pid: number) { const row = (await processes()).find(p => p.pid === pid && !p.state.includes('Z')); return row && { pid: row.pid, pgid: row.pgid, started: row.started }; }
export function sameProcess(a: ProcessIdentity, b?: ProcessIdentity) { return !!b && a.pid === b.pid && a.pgid === b.pgid && a.started === b.started; }
export async function alive(p?: ProcessIdentity) { return !!p && sameProcess(p, await identity(p.pid)); }
export async function signalOwned(p: ProcessIdentity, signal: NodeJS.Signals) {
  if (!await alive(p)) return false;
  try { process.kill(p.pid, signal); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e; }
}
/** The live anchor proves ownership of this process group; each PID is rechecked.
 * Never pkill, search command names, or signal a PID whose start identity changed. */
export async function stopGroup(anchor: ProcessIdentity, keepSelf = false) {
  if (!await alive(anchor)) return false;
  const group = anchor.pgid;
  const members = async () => (await processes()).filter(p => p.pgid === group && !p.state.includes('Z') && (!keepSelf || p.pid !== process.pid));
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!await alive(anchor)) return !(await members()).length;
    const targets = await members();
    // The anchor is last, so descendants cannot lose the live ownership check first.
    targets.sort((a, b) => Number(a.pid === anchor.pid) - Number(b.pid === anchor.pid));
    for (const member of targets) await signalOwned(member, signal);
    for (let i = 0; i < 10; i++) { if (!(await members()).length) return true; await sleep(50); }
  }
  return !(await members()).length;
}
export async function privateJson<T>(path: string, maxBytes = 2 * 1024 * 1024): Promise<T | undefined> {
  // Supervisors atomically replace receipts. A descriptor opened just before
  // rename may have nlink=0 by fstat: it is a retired snapshot, not corruption.
  // Reopen the fixed path; never read the unlinked inode or relax the nlink=1 guard.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await fd.stat();
        if (info.isFile() && info.nlink === 0) continue;
        if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('私有回执不安全');
        return parseJson<T>(await fd.readFile('utf8'));
      } finally { await fd.close(); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
  // Repeated replacement means no stable observation this tick. The owner stays
  // monitored; a later poll can read its receipt, without retrying the dispatch.
  return undefined;
}
