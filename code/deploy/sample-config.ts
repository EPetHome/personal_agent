import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { validateConfig } from '../src/core/config.ts';
import { errorMessage } from '../src/core/utils.ts';

const usage = '用法：node code/deploy/sample-config.ts <场景目录> <新的临时数据目录> <配置输出路径>';
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new Error(usage);
  const [scene, dataDir, output] = args.map(path => resolve(path)) as [string, string, string];
  if (!(await lstat(join(scene, '卡片.md'))).isFile()) throw new Error('该目录不是场景样本');
  for (const destination of [dataDir, output]) {
    const diff = relative(dirname(scene), destination);
    if (diff === '' || (!diff.startsWith('../') && diff !== '..')) throw new Error('配置和数据不能写入样本树，请使用独立临时目录');
  }
  async function source(name: string) {
    const path = join(scene, name);
    try { if ((await lstat(path)).isDirectory()) return path; throw new Error(`${path} 不是目录`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  const config = await validateConfig({
    sources: { cc: await source('claude-projects'), codex: await source('codex-sessions'), pi: await source('pi-sessions'), loop: await source('pi-autoreview') },
    inboxDir: await source('inbox'), dataDir,
    // 仅生成回看文字，绝不启动这些工具。验收不需要安装它们。
    commands: { cc: 'claude', codex: '/sample-tools/codex', pi: 'pi' },
  });
  // 同样检查符号链接别名，不能通过临时路径把配置/数据写回样本树。
  for (const destination of [dataDir, output]) {
    await validateConfig({ ...config, dataDir: destination, sources: { cc: dirname(scene), codex: null, pi: null, loop: null }, inboxDir: null });
  }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`已生成 ${output}；dataDir=${dataDir}（来源只读，缺少的来源显式设为 null）`);
}
main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
