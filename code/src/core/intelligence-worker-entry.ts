import { runIntelligenceWorker } from './intelligence-worker.ts';
import { validateConfig } from './config.ts';

// 只有协调程序传入的显式配置，没有默认个人目录，也不接收模型产出的动作。
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 128 * 1024) throw new Error('后台配置过大');
  }
  const data = JSON.parse(input);
  await runIntelligenceWorker(await validateConfig(data.config), data.now);
} catch { process.exitCode = 1; /* 不把原始错误或材料写到外部日志 */ }
