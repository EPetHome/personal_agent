import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { assertRegularFile } from '../../core/config.ts';
import type { Config } from '../../core/types.ts';
import type { CalendarMeeting } from '../../core/managed-types.ts';
import type { HttpInstance } from '@larksuiteoapi/node-sdk';

export interface MinuteMaterial { id: string; title: string; text: string; todos?: string[] }
export interface ScheduleReader {
  calendar(calendarId: string, from: string, to: string): Promise<CalendarMeeting[]>;
  minute(token: string): Promise<MinuteMaterial>;
  discoverMinutes?(ownerIds: string[], from: string, to: string): Promise<string[]>;
}
type Sdk = typeof import('@larksuiteoapi/node-sdk');
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
/** 只读官方SDK；凭证/SDK报文不进入账本、卡片或日志。注入http仅供离线验证。 */
export async function feishuScheduleReader(config: Config, dependencies: {
  credentials?: { appId: string; appSecret: string; userAccessToken: string };
  loadSdk?: () => Promise<Sdk>; httpInstance?: HttpInstance;
} = {}): Promise<ScheduleReader> {
  const schedule = config.schedule;
  if (!schedule || schedule.mode !== 'real') throw new Error('未启用真实日程');
  let credentials = dependencies.credentials;
  if (!credentials) {
    let file: NodeJS.Dict<string> = {};
    const envFile = schedule.envFile ?? config.feishu?.envFile;
    if (envFile) { await assertRegularFile(envFile); file = parseEnv(await readFile(envFile, 'utf8')); }
    credentials = { appId: process.env.FEISHU_APP_ID ?? file.FEISHU_APP_ID ?? '', appSecret: process.env.FEISHU_APP_SECRET ?? file.FEISHU_APP_SECRET ?? '',
      userAccessToken: process.env.FEISHU_USER_ACCESS_TOKEN ?? file.FEISHU_USER_ACCESS_TOKEN ?? '' };
  }
  if (!/^cli_[0-9a-fA-F]{16}$/.test(credentials.appId) || !credentials.appSecret || !credentials.userAccessToken) throw new Error('日程需要本人授权的用户凭证，请检查环境或.env');
  const sdk = await (dependencies.loadSdk?.() ?? import('@larksuiteoapi/node-sdk'));
  const upstream: HttpInstance = dependencies.httpInstance ?? sdk.defaultHttpInstance as unknown as HttpInstance;
  const http = Object.create(upstream) as HttpInstance;
  http.request = options => upstream.request({ ...options, timeout: schedule.timeoutMs });
  const client = new sdk.Client({ appId: credentials.appId, appSecret: credentials.appSecret, appType: sdk.AppType.SelfBuild, logger: quiet, httpInstance: http });
  const options = sdk.withUserAccessToken(credentials.userAccessToken);
  return {
    async calendar(calendarId, from, to) {
      const response = await client.calendar.v4.calendarEvent.instanceView({ path: { calendar_id: calendarId },
        params: { start_time: String(Math.floor(Date.parse(from) / 1000)), end_time: String(Math.ceil(Date.parse(to) / 1000)), user_id_type: 'open_id' } }, options);
      if (response.code !== 0 || !response.data || !Array.isArray(response.data.items)) throw new Error('日历读取失败');
      return response.data.items.flatMap(event => {
        // 全天事项、空闲、已拒绝和已取消不当作正在开会；重复日程由官方视图展开。
        if (event.status === 'cancelled' || event.free_busy_status === 'free' || ['decline', 'removed'].includes(event.self_rsvp_status ?? '')
          || !event.start_time?.timestamp || !event.end_time?.timestamp) return [];
        const start = Number(event.start_time.timestamp) * 1000, end = Number(event.end_time.timestamp) * 1000;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
        return [{ id: event.event_id, calendarId, title: (event.summary ?? '会议').slice(0, 500), start: new Date(start).toISOString(), end: new Date(end).toISOString() }];
      });
    },
    async discoverMinutes(ownerIds, from, to) {
      if (!ownerIds.length) return [];
      const tokens = new Set<string>(); let pageToken: string | undefined;
      for (let page = 0; page < 20; page++) {
        const response = await client.minutes.v1.minute.search({ data: { query: '', filter: { owner_ids: ownerIds,
          create_time: { start_time: String(Date.parse(from)), end_time: String(Date.parse(to)) } }, sorter: 'create_time_desc' },
          params: { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}), user_id_type: 'open_id' } }, options);
        if (response.code !== 0 || !response.data || !Array.isArray(response.data.items)) throw new Error('妙记发现失败');
        for (const item of response.data.items) if (typeof item.token === 'string') tokens.add(item.token);
        if (!response.data.has_more) return [...tokens];
        if (!response.data.page_token || response.data.page_token === pageToken) throw new Error('妙记分页不完整');
        pageToken = response.data.page_token;
      }
      throw new Error('妙记发现超过1000项，需缩小本人配置的范围');
    },
    async minute(token) {
      const metadata = await client.minutes.v1.minute.get({ path: { minute_token: token } }, options);
      if (metadata.code !== 0 || !metadata.data?.minute) throw new Error('妙记读取失败');
      let text = '', todos: string[] | undefined;
      try {
        const artifacts = await client.minutes.v1.minute.artifacts({ path: { minute_token: token } }, options);
        if (artifacts.code !== 0 || !artifacts.data) throw new Error('AI产物不可用');
        text = [artifacts.data.summary, artifacts.data.transcript].filter(Boolean).join('\n').slice(0, 32768);
        todos = artifacts.data.minute_todos?.filter(todo => !todo.is_done && todo.operation !== 'delete').map(todo => todo.content ?? '').filter(Boolean).slice(0, 20);
      } catch { /* 未生成AI产物/无权限时，只读导出文字记录，不创建/订阅/修改任何资源。 */ }
      if (!text && !todos?.length) {
        const transcript = await client.minutes.v1.minuteTranscript.get({ path: { minute_token: token }, params: { need_speaker: false, need_timestamp: false, file_format: 'txt' } }, options);
        const stream = transcript.getReadableStream(), chunks: Buffer[] = []; let bytes = 0;
        const timer = setTimeout(() => stream.destroy(new Error('妙记读取超时')), schedule.timeoutMs);
        try { for await (const chunk of stream) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 32768) throw new Error('妙记文字超过读取上限'); chunks.push(buffer); } }
        finally { clearTimeout(timer); stream.destroy(); }
        text = Buffer.concat(chunks).toString('utf8');
      }
      return { id: token, title: (metadata.data.minute.title ?? '会议纪要').slice(0, 500), text, ...(todos ? { todos } : {}) };
    },
  };
}
