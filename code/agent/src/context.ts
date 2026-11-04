import { AsyncLocalStorage } from 'node:async_hooks';
import type { Turn } from './types.js';
export const turns = new AsyncLocalStorage<Turn>();
export function turn(): Turn { const value = turns.getStore(); if (!value) throw new Error('No active input'); return value; }
