import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import type { Config } from './types.js';
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function plist(c: Config, watchdog = false) {
  const label = watchdog ? 'local.personal-agent-v2.watchdog' : 'local.personal-agent-v2';
  const args = [process.execPath, fileURLToPath(new URL(watchdog ? './watchdog-main.js' : './main.js', import.meta.url)), '--config', c.configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(resolve(fileURLToPath(new URL('../..', import.meta.url))))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(c.dataDir, `${label}.stdout.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(c.dataDir, `${label}.stderr.log`))}</string>
</dict></plist>\n`;
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes('--config') || !process.argv.includes('--out')) throw new Error('用法：node dist/src/launchd.js --config /config.json --out /临时目录/plists');
  const c = await loadConfig(arg('--config')!), out = resolve(arg('--out')!);
  await mkdir(out, { recursive: true, mode: 0o700 });
  for (const watchdog of [false, true]) await writeFile(join(out, watchdog ? 'local.personal-agent-v2.watchdog.plist' : 'local.personal-agent-v2.plist'), plist(c, watchdog), { mode: 0o600, flag: 'wx' });
  console.log(`仅生成两个 plist：${out}；未安装、未加载 launchd。`);
}
