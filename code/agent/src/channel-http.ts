import { AsyncLocalStorage } from 'node:async_hooks';
import { defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk';
import { localUrl } from './util.js';

export class ChannelDeadlineError extends Error { constructor() { super('渠道操作超时'); } }
export class DeliveryUncertain extends Error { constructor() { super('发送结果不确定，不重发'); } }

/** One wall-clock deadline across authentication, headers, body and file pipeline.
 * The guard also bounds a misbehaving adapter; actual HTTP/stream I/O receives
 * the same abort signal, so timing out is not just abandoning a live socket. */
export async function withDeadline<T>(timeoutMs: number, caller: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new ChannelDeadlineError()), timeoutMs);
  const signal = caller ? AbortSignal.any([caller, timeout.signal]) : timeout.signal;
  try {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }).then(value => {
        signal.removeEventListener('abort', aborted); resolve(value);
      }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    });
  } finally { clearTimeout(timer); }
}

/** Per-client SDK adapter, including the SDK's otherwise-unbounded token calls.
 * Do not mutate the SDK's process-global axios defaults or import a new package. */
export class SdkRequests {
  private readonly scope = new AsyncLocalStorage<AbortSignal>();
  private readonly background = new AbortController();
  readonly http: HttpInstance;
  constructor(readonly timeoutMs: number) {
    const method = (verb: string) => <T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) => this.request<T, R, D>({ ...opts, url, method: verb });
    const dataMethod = (verb: string) => <T = unknown, R = T, D = unknown>(url: string, data?: D, opts?: HttpRequestOptions<D>) => this.request<T, R, D>({ ...opts, url, data, method: verb });
    this.http = { request: <T = unknown, R = T, D = unknown>(opts: HttpRequestOptions<D>) => this.request<T, R, D>(opts),
      get: method('GET'), delete: method('DELETE'), head: method('HEAD'), options: method('OPTIONS'), post: dataMethod('POST'), put: dataMethod('PUT'), patch: dataMethod('PATCH') };
  }
  run<T>(caller: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>) {
    return withDeadline(this.timeoutMs, caller, signal => this.scope.run(signal, () => work(signal)));
  }
  private request<T, R, D>(opts: HttpRequestOptions<D>): Promise<R> {
    const parent = this.scope.getStore() ?? this.background.signal;
    return withDeadline(this.timeoutMs, parent, async signal => {
      const response = await defaultHttpInstance.request<T, R, D>({ ...opts,
        timeout: this.timeoutMs, signal, ...(opts.url && localUrl(opts.url) ? { proxy: false } : {}) });
      // SAFETY: the pinned SDK's default response interceptor unwraps data (or
      // {data, headers} for streams), exactly the HttpInstance R contract.
      return response as unknown as R;
    });
  }
  stopBackground() { this.background.abort(new Error('渠道接收已停止')); }
}
