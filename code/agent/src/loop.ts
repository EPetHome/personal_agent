import { spawn } from 'node:child_process';
import type { Config, Material } from './types.js';
import type { Files } from './files.js';
import { canonical, hash, parseJson } from './util.js';

export async function queryLoop(c: Config, files: Files, materials: Material[]) {
  if (!c.loop.command) return { ok: false, error: '尚未配置 Loop 只读查询命令' };
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(c.loop.command, [...c.loop.args, '查询', '--all', '--json'], { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let output = '', settled = false;
    const end = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); end(new Error('Loop 只读查询超时')); }, c.loop.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (Buffer.byteLength(output) > 2 * 1024 * 1024) { child.kill('SIGKILL'); end(new Error('Loop 查询输出超过大小上限')); } });
    child.once('error', () => end(new Error('Loop 查询无法启动')));
    child.once('exit', code => end(code === 0 ? undefined : new Error('Loop 查询失败')));
  });
  const result = parseJson<{ v: number; at: string; batches: any[] }>(text);
  if (result.v !== 1 || !Array.isArray(result.batches)) throw new Error('Loop 查询返回的不是 v1 格式');
  const roots = await Promise.all(c.projects.map(p => canonical(p.root)));
  const batches = [];
  for (const batch of result.batches) {
    if (typeof batch.project !== 'string' || !roots.includes(await canonical(batch.project))) continue;
    await files.registerEvidence(batch.project, batch.evidence ?? {});
    for (const stage of batch.stages ?? []) await files.registerEvidence(batch.project, stage.evidence ?? {});
    batches.push(batch);
  }
  const filtered = { v: 1, at: result.at, batches };
  materials.push({ path: 'loop://查询/authorized-projects', sha256: hash(JSON.stringify(filtered)) });
  return filtered;
}
