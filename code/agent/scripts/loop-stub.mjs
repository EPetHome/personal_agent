import { readFile, appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const i = args.indexOf('--state'), log = args.indexOf('--calls');
if (i < 0 || args.slice(-3).join(' ') !== '查询 --all --json') { console.error('Loop 替身只允许：--state /snapshot.json [--calls /calls.jsonl] 查询 --all --json'); process.exit(2); }
if (log >= 0) await appendFile(args[log + 1], JSON.stringify({ args: args.slice(-3), at: new Date().toISOString() }) + '\n');
const value = JSON.parse(await readFile(args[i + 1], 'utf8'));
console.log(JSON.stringify(value));
