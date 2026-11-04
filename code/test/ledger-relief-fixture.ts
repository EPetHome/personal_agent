import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../src/core/utils.ts';
import { ledgerPath } from '../src/core/ledger.ts';
import type { LedgerChange, LedgerTransaction, ManagedCard } from '../src/core/managed-types.ts';

export const at = '2026-11-03T10:00:00.000Z';
/** 测试当场生成，不提交大账本；使用合入前 schema=1 的原格式/校验链。 */
export async function largeLedger(dataDir: string, lines = 10001, cards = 50) {
  await mkdir(dataDir, { recursive: true });
  let previous = '', seq = 0;
  const rows: string[] = [];
  const append = (changes: LedgerChange[]) => {
    const body = { schema: 1 as const, id: `constructed-${++seq}`, seq, at, previous, changes };
    const row: LedgerTransaction = { ...body, checksum: hash(JSON.stringify(body)) };
    previous = row.checksum; rows.push(JSON.stringify(row) + '\n');
  };
  for (let i = 0; i < lines; i++) append([{ kind: 'put', table: 'receipts', value: { id: ['poll:workspace', 'heartbeat:main', 'inspection'][i % 3]!, at, response: '构造的旧版例行回执' } }]);
  for (let i = 0; i < cards; i++) {
    const id = `health:history:${i}`;
    const card: ManagedCard = { id, ticketId: '', assignmentId: '', eventId: `old-${i}`, revision: 1, at, title: '构造的已送达历史卡', fact: '已经处理完的历史通知',
      question: '', suggestion: '不用管', basis: '构造数据', redline: false, options: [], actionMode: 'none' };
    append([{ kind: 'put', table: 'cards', value: card }, ...['local', 'feishu'].map(channel => ({ kind: 'put' as const, table: 'deliveries' as const,
      value: { id: `${channel}:${id}:1`, cardId: id, eventId: card.eventId, revision: 1, channel, state: 'sent' as const, failures: 0, messageId: `${channel}:old-${i}` } }))]);
  }
  const content = rows.join(''); await writeFile(ledgerPath(dataDir), content);
  return { content, seq, checksum: previous, lines: rows.length };
}
export const notificationStub = async (root: string) => {
  const { chmod } = await import('node:fs/promises'), path = join(root, 'notify-stub');
  await writeFile(path, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(root, 'notifications.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
  await chmod(path, 0o700); return path;
};
