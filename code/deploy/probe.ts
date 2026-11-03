#!/usr/bin/env node
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.ts';
import { runCommand, runJsonCommand } from '../src/core/process.ts';
import { loopEnvironment } from '../src/core/loop-worker.ts';
import type { Config } from '../src/core/types.ts';

/** 无模型请求、不安装、不下载、不登录、不刷新token；只运行显式入口的版本/帮助和只读查询。 */
export async function probeConnections(config: Config) {
  const checks: { capability: string; ready: boolean; detail: string }[] = [];
  const check = async (capability: string, action: () => Promise<string>) => {
    try { checks.push({ capability, ready: true, detail: await action() }); }
    catch { checks.push({ capability, ready: false, detail: '入口、协议或本地能力未就绪；未重试、未调用真实模型' }); }
  };
  if (config.worker?.protocol === 'loop-v1') await check('loop.query', async () => {
    const result = await runJsonCommand(config.worker!.executable, [...config.worker!.args, '查询', '--all', '--json'], config.worker!.timeoutMs, undefined, undefined, loopEnvironment()) as any;
    if (result?.v !== 1 || !Array.isArray(result.batches)) throw new Error('协议不符'); return '官方v1只读查询可用；没有启动/恢复队列';
  });
  else checks.push({ capability: 'loop.query', ready: false, detail: '没有配置真实loop-v1入口' });
  if (config.piWorker?.protocol === 'pi-v1') await check('pi.protocol', async () => {
    const version = (await runCommand(config.piWorker!.executable, ['--offline', '--no-tools', '--no-session', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-themes', '--no-approve', '--version'], 10000)).trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('版本不符'); return `Pi ${version}；只证明程序可运行，模型/凭据未验证`;
  });
  else checks.push({ capability: 'pi.protocol', ready: false, detail: '没有配置真实pi-v1入口' });
  if (config.piWorker?.transcriber) await check('transcribe.local', async () => {
    const tool = config.piWorker!.transcriber!;
    const model = await lstat(tool.modelFile); if (!model.isFile() || model.nlink !== 1 || !model.size) throw new Error('本地模型缺失');
    const help = await runCommand(tool.executable, ['--help'], 20000), ffmpeg = await runCommand(tool.ffmpeg, ['-version'], 10000);
    if (!help.includes('--model') || !help.includes('--output_dir') || !ffmpeg.includes('ffmpeg version')) throw new Error('工具能力不足');
    return `工具可运行、模型文件存在；${await realpath(tool.modelFile)}。未加载模型/转写，不保证模型内容有效`;
  });
  else checks.push({ capability: 'transcribe.local', ready: false, detail: '未配置本地模型及工具；不会自动下载' });
  checks.push({ capability: 'loop.push_merge', ready: false, detail: '当前官方接口缺少预期目标绑定，推送另缺完整秘密扫描；已硬拒绝' },
    { capability: 'loop.acceptance_only', ready: false, detail: '当前Loop不支持该配方；没有降级成开发' },
    { capability: 'schedule.authorization', ready: false, detail: '未读取凭据、未登录或读取真实资源；需用户完成v3 OAuth并核对范围，不能以应用凭据冒充用户授权' });
  return { checks, modelNotCalled: true, credentialsNotReadByProbe: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') { console.error('用法：node code/deploy/probe.ts --config <显式绝对配置>'); process.exitCode = 2; }
  else loadConfig(process.argv[3]).then(probeConnections).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error('能力探测未完成，保留未就绪状态（未输出原始异常）'); process.exitCode = 1; });
}
