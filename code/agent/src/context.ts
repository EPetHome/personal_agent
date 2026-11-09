import { AsyncLocalStorage } from 'node:async_hooks';
import type { Turn } from './types.js';
import type { Store } from './store.js';
import { SafeError } from './errors.js';
export const turns = new AsyncLocalStorage<Turn>();
export function turn(): Turn { const value = turns.getStore(); if (!value) throw new Error('No active input'); return value; }

/** Disclosure dependencies only accumulate within one input. A late card or a
 * stale Turn must never erase evidence of body text already sent/injected. */
export function retainObservationGrants(store: Pick<Store, 'get' | 'set' | 'transaction'>, inputId: string, additions: Record<string, string> = {}, access?: string, active = turns.getStore()) {
  const target = active?.input.id === inputId ? active : undefined;
  const merged = store.transaction(() => {
    const saved = store.get<Record<string, string>>(`reply:grants:${inputId}`, {}), result = { ...saved };
    for (const grants of [target?.observationGrants ?? {}, additions]) for (const [id, grant] of Object.entries(grants)) {
      if (Object.hasOwn(result, id) && result[id] !== grant) throw new SafeError('outside_scope', '同回合来源授权版本冲突，不替换已记录的披露依赖');
      Object.defineProperty(result, id, { value: grant, enumerable: true, configurable: true, writable: true });
    }
    const key = `reply:access:${inputId}`, previous = store.get<string | null>(key, null);
    if (access && previous && Object.keys(result).length && previous !== access) throw new SafeError('outside_scope', '观察资源授权已变，本轮旧内容不再披露');
    if (JSON.stringify(saved) !== JSON.stringify(result)) store.set(`reply:grants:${inputId}`, result);
    if (access && !previous) store.set(key, access);
    return result;
  });
  if (target) target.observationGrants = merged;
  return merged;
}
