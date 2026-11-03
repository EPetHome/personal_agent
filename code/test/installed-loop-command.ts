// 测试边界：使用安装版CLI解析/查询/送话/开工/启动；仅续跑的模型/宿主启动点隔离。
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, capture, ...argv] = process.argv.slice(2), input = readFileSync(0, 'utf8');
const load = (name: string) => import(pathToFileURL(join(root!, name)).href);
const { parseArgs } = await load('loop.ts');
const parsed = parseArgs(argv); appendFileSync(capture!, JSON.stringify({ argv, input }) + '\n');
if (parsed.command === '续跑') {
  const { resumeBatch } = await load('pa-resume.ts'), { paInfo } = await load('pa.ts'), { processStartTime } = await load('procs.ts');
  const result = await resumeBatch({ info: paInfo(parsed.batch), id: parsed.id, readGrant: parsed.grantFile ? () => input : undefined, launch: async (command: string[]) => {
    appendFileSync(capture!, JSON.stringify({ launch: command, input }) + '\n'); return { pid: process.ppid, processStarted: processStartTime(process.ppid) };
  } });
  console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
} else {
  try { const output = execFileSync(process.execPath, [join(root!, 'loop.ts'), ...argv], { input, encoding: 'utf8', env: process.env, cwd: process.cwd(), timeout: 30000 }); if (parsed.command === '开工') appendFileSync(capture!, JSON.stringify({ argv: [], reply: JSON.parse(output) }) + '\n'); process.stdout.write(output); }
  catch (error) { const failure = error as { stdout?: string; status?: number }; appendFileSync(capture!, JSON.stringify({ argv: [], reply: failure.stdout }) + '\n'); process.stdout.write(failure.stdout ?? ''); process.exitCode = failure.status ?? 1; }
}
