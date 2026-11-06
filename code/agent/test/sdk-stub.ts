import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StalledPhase = 'auth' | 'send' | 'update' | 'download-headers' | 'download-body' | null;
/** Actual official SDK talks only to this loopback REST server with invented credentials. */
export async function sdkStub() {
  let phase: StalledPhase = null, stalled = 0, closed = 0;
  const calls: { method: string; path: string; body: string }[] = [], messages: string[] = [];
  const json = (res: ServerResponse, value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/', method = req.method ?? '';
      calls.push({ method, path, body: Buffer.concat(chunks).toString('utf8') });
      const auth = path.includes('/auth/'), download = path.includes('/resources/'), send = method === 'POST' && !auth;
      const hangs = auth && phase === 'auth' || send && phase === 'send' || (method === 'PUT' || method === 'PATCH') && phase === 'update' || download && (phase === 'download-headers' || phase === 'download-body');
      if (hangs) {
        stalled++; let timer: NodeJS.Timeout | undefined;
        res.on('close', () => { closed++; clearInterval(timer); });
        if (phase === 'download-body') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write('partial fixture');
          // Activity keeps idle socket timeouts alive: the absolute deadline must still cancel it.
          timer = setInterval(() => res.write('.'), 15);
        }
        return;
      }
      if (auth) { json(res, { code: 0, tenant_access_token: 'SYNTHETIC_SDK_TOKEN', expire: 7200 }); return; }
      if (download) { res.end('complete synthetic attachment'); return; }
      if (send) {
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); const text = JSON.parse(value.content).text; if (typeof text === 'string') messages.push(text); }
        catch { json(res, { code: 1 }); return; }
      }
      json(res, { code: 0, data: { message_id: `om_local_${calls.length}` } });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, messages,
    stall(value: StalledPhase) { phase = value; },
    get stalled() { return stalled; }, get closed() { return closed; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); },
  };
}
