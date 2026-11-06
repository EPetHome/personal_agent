import { readFile, appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法：node scripts/loop-stub.mjs --state <快照JSON> [--calls <调用JSONL>] 查询 --all --json
参数：--state 指定构造快照；--calls 可选，追加调用记录；只接受 查询 --all --json；--help/-h 只显示帮助。
常驻：否，读取一次快照、输出 JSON 后退出，不连接真实 Loop。
停止：通常无需停止；中止本次调用用 Ctrl-C / SIGTERM。
帮助立即以退出码 0 结束，不读取快照，不建目录、不起服务、不写文件。`);
  process.exit(0);
}
const i = args.indexOf('--state'), log = args.indexOf('--calls');
if (i < 0 || args.slice(-3).join(' ') !== '查询 --all --json') { console.error('Loop 替身只允许：--state /snapshot.json [--calls /calls.jsonl] 查询 --all --json'); process.exit(2); }
if (log >= 0) await appendFile(args[log + 1], JSON.stringify({ args: args.slice(-3), at: new Date().toISOString() }) + '\n');
const value = JSON.parse(await readFile(args[i + 1], 'utf8'));
console.log(JSON.stringify(value));
