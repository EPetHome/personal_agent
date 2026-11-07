import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deliver, makeChannel, type MessageCard } from '../src/channel.js';
import { Store } from '../src/store.js';
import { hash, sleep } from '../src/util.js';
import { fixture, until } from './helpers.js';
import { sdkStub } from './sdk-stub.js';

async function transports(t: TestContext, timeoutMs = 2000) {
  const f = await fixture(), rest = await sdkStub(); f.config.feishu.timeoutMs = timeoutMs;
  const fake = await makeChannel(f.config);
  const real = await makeChannel({ ...f.config, feishu: { ...f.config.feishu, mode: 'real' } }, undefined,
    { domain: rest.url, credentials: { appId: `cli_synthetic_${randomUUID()}`, appSecret: 'SYNTHETIC_APP_SECRET' } });
  t.after(async () => { await real.stop(); await fake.stop(); await rest.close(); await f.close(); });
  return { f, rest, fake, real };
}
const sends = (rest: Awaited<ReturnType<typeof sdkStub>>) => rest.calls.filter(c => c.method === 'POST' && c.path.includes('/im/v1/messages'));

const examples = [
  {
    name: 'plain Chinese, whitespace, line endings and numbers are verbatim',
    input: '普通正文  \r\n第二行：001、-3.50、0%、🙂\n\n尾行\r',
    output: '普通正文  \r\n第二行：001、-3.50、0%、🙂\n\n尾行\r',
  },
  {
    name: 'long unbroken Chinese and ASCII prose stays verbatim',
    input: '构造正文'.repeat(2000) + '\n' + 'ordinary'.repeat(1000),
    output: '构造正文'.repeat(2000) + '\n' + 'ordinary'.repeat(1000),
  },
  {
    name: 'A8 headings, emphasis, lists and table retain field/value relationships',
    input: '# 工作状态\n\n**已核实**，*仍需人工*，__重点__，_待确认_。\n- 基础适配：**进行中**\n+ 排版：未核实\n  * 子项：3\n1. 不重发\n\n| 工作 | 状态 | 数量 |\n| :--- | --- | ---: |\n| 基础适配 | **进行中** | 12 |\n| 飞书排版 | 未核实 | 3.50 |\n',
    output: '工作状态\n\n已核实，仍需人工，重点，待确认。\n• 基础适配：进行中\n• 排版：未核实\n  • 子项：3\n1. 不重发\n\n1. 工作：基础适配\n   状态：进行中\n   数量：12\n\n2. 工作：飞书排版\n   状态：未核实\n   数量：3.50\n',
  },
  {
    name: 'heading levels, optional closing hashes and ordered list numbering',
    input: '## 二级 ##\n### 三级\n#### 四级\n##### 五级\n###### 六级\n2) **第二项**\n10. 第十项\n#不是标题\nC# 与 #tag',
    output: '二级\n三级\n四级\n五级\n六级\n2) 第二项\n10. 第十项\n#不是标题\nC# 与 #tag',
  },
  {
    name: 'A9 literal operators, underscore paths, URLs and Chinese newlines',
    input: String.raw`a*b、a*b*c、a|b、foo_bar、a__b__c、任务_基础_状态、数量*单价*税率
路径：/tmp/under_score/中文_待办_清单.md
相对路径：code/agent/file_name.ts 和 资料_待办/版本_文件.txt
文件：__init__.py、资料_待办_清单.md
Windows：C:\work\folder_name\file_one.txt
链接：https://example.invalid/a_b?q=*literal*&x=a|b
中文第二行`,
    output: String.raw`a*b、a*b*c、a|b、foo_bar、a__b__c、任务_基础_状态、数量*单价*税率
路径：/tmp/under_score/中文_待办_清单.md
相对路径：code/agent/file_name.ts 和 资料_待办/版本_文件.txt
文件：__init__.py、资料_待办_清单.md
Windows：C:\work\folder_name\file_one.txt
链接：https://example.invalid/a_b?q=*literal*&x=a|b
中文第二行`,
  },
  {
    name: 'inline code content, pipes, hashes and multiple backticks are protected',
    input: '命令：`printf \'a|b\' | grep \'_\'`\n代码：``a*b **x** _y_ `z` ``\n**`# 原样 ** | _`**',
    output: '命令：printf \'a|b\' | grep \'_\'\n代码：a*b **x** _y_ `z` \n# 原样 ** | _',
  },
  {
    name: 'fenced code preserves every body character and CRLF, not a nested table',
    input: '# 示例\r\n```sh\r\n# code heading\r\nprintf \'a*b|_\' | cat\r\n| A | B |\r\n| --- | --- |\r\n| x | 0 |\r\n```\r\n**结束**',
    output: '示例\r\n代码（sh）：\r\n# code heading\r\nprintf \'a*b|_\' | cat\r\n| A | B |\r\n| --- | --- |\r\n| x | 0 |\r\n\r\n结束',
  },
  {
    name: 'long and tilde fences do not terminate on shorter or different fences',
    input: '````txt\n```\n**not bold**\n````\n~~~\n# code\n~~~',
    output: '代码（txt）：\n```\n**not bold**\n\n代码：\n# code\n',
  },
  {
    name: 'table without outer pipes protects code pipes and escaped pipe content',
    input: '命令 | 值\n:--- | ---:\n`printf a|b` | a\\|b\n`a*b **x** _y_` | /tmp/file_name.txt',
    output: '1. 命令：printf a|b\n   值：a|b\n\n2. 命令：a*b **x** _y_\n   值：/tmp/file_name.txt',
  },
  {
    name: 'empty cells, leading zeros, decimals, negatives and single-column table',
    input: '| 名称 | 数值 | 备注 |\n| --- | --- | --- |\n| 001 | -3.50 | |\n| 零 | 0% | 待核实 |\n\n| 单列 |\n| --- |\n| **保留** |',
    output: '1. 名称：001\n   数值：-3.50\n   备注：\n\n2. 名称：零\n   数值：0%\n   备注：待核实\n\n1. 单列：保留',
  },
  {
    name: 'simple links retain label, URL, query, parentheses and title; images fall back',
    input: '[说明 **全文**](https://example.invalid/a_(b)?q=a*b_c "构造标题")\n![构造图片](https://example.invalid/a_b.png)\n**https://example.invalid/a_b**',
    output: '说明 全文（https://example.invalid/a_(b)?q=a*b_c "构造标题"）\n![构造图片](https://example.invalid/a_b.png)\nhttps://example.invalid/a_b',
  },
  {
    name: 'ragged table explicitly falls back as a whole, dropping no extra fields',
    input: '| 工作 | 状态 |\n| --- | --- |\n| **排版** | 进行中 | 额外字段：42 |\n| 基础 | 未知 |\n\n**后文**',
    output: '表格格式暂不支持，以下保留原文：\n| 工作 | 状态 |\n| --- | --- |\n| **排版** | 进行中 | 额外字段：42 |\n| 基础 | 未知 |\n\n后文',
  },
  {
    name: 'empty table header and missing cells fall back without guessing labels',
    input: '| 工作 | |\n| --- | --- |\n| 排版 | 12 |\n\n| 工作 | 状态 |\n| --- | --- |\n| 排版 |',
    output: '表格格式暂不支持，以下保留原文：\n| 工作 | |\n| --- | --- |\n| 排版 | 12 |\n\n表格格式暂不支持，以下保留原文：\n| 工作 | 状态 |\n| --- | --- |\n| 排版 |',
  },
  {
    name: 'header-only table keeps header information instead of disappearing',
    input: '| 工作 | 状态 |\n| --- | --- |',
    output: '表格格式暂不支持，以下保留原文：\n| 工作 | 状态 |\n| --- | --- |',
  },
  {
    name: 'unclosed fence and inline code fall back verbatim',
    input: '**正文** `a*b **code**\n```sh\n# 原始注释\n**literal**\n| a | b |',
    output: '正文 `a*b **code**\n```sh\n# 原始注释\n**literal**\n| a | b |',
  },
  {
    name: 'indented code, escapes and unsupported syntax remain literal',
    input: '    # code\n    **keep** | _keep_\n\t- code\n\\*literal\\* 与 \\_literal\\_\n~~保留~~\n[引用][ref]\n<div>构造文字</div>\n---\n***',
    output: '    # code\n    **keep** | _keep_\n\t- code\n\\*literal\\* 与 \\_literal\\_\n~~保留~~\n[引用][ref]\n<div>构造文字</div>\n---\n***',
  },
  {
    name: 'multiline inline code falls back without interpreting its content',
    input: '**正文** `first\n**code** a*b | _x_\nlast` **原文回退**\n**恢复正文**',
    output: '正文 `first\n**code** a*b | _x_\nlast` **原文回退**\n恢复正文',
  },
  {
    name: 'emphasized absolute paths retain their contents, not wrapper markers',
    input: '**/tmp/file_name.txt** 与 **C:\\work\\file_name.txt**',
    output: '/tmp/file_name.txt 与 C:\\work\\file_name.txt',
  },
  {
    name: 'literal placeholder-like characters cannot collide with protected code',
    input: '\u00000\u0000 **正文** `a*b`',
    output: '\u00000\u0000 正文 a*b',
  },
];

for (const example of examples) test(`format transport: ${example.name}`, async t => {
  const { f, rest, fake, real } = await transports(t);
  const key = `format:${example.name}`, id = await real.send(example.input, key);
  await real.update(id, example.input);
  const create = sends(rest); assert.equal(create.length, 1);
  const sent = JSON.parse(create[0]!.body), updates = rest.calls.filter(c => c.method === 'PUT');
  assert.equal(sent.msg_type, 'text'); assert.equal(sent.receive_id, 'owner'); assert.equal(sent.uuid, hash(key).slice(0, 32));
  assert.equal(new URL(create[0]!.path, rest.url).searchParams.get('receive_id_type'), 'open_id');
  assert.deepEqual(JSON.parse(sent.content), { text: example.output });
  assert.equal(updates.length, 1); assert.ok(updates[0]!.path.endsWith(`/messages/${id}`));
  assert.deepEqual(JSON.parse(updates[0]!.body), { msg_type: 'text', content: JSON.stringify({ text: example.output }) });
  assert.deepEqual(rest.messages, [example.output]);
  const fakeId = await fake.send(example.input, key); await fake.update(fakeId, example.input);
  assert.equal(f.feishu.messages[0]!.text, example.output); assert.deepEqual(f.feishu.messages[0]!.updates, [example.output]);
  assert.equal(f.model.requests.length, 0, 'no model rewriting');
});

test('A8: updating an existing message converts new status text, not cached send text', async t => {
  const { rest, real } = await transports(t);
  const id = await real.send('## 状态\n- **未核实**：3', 'status');
  await real.update(id, '## 状态\n| 工作 | 状态 |\n| --- | --- |\n| 排版 | **已检查** |');
  assert.equal(rest.messages[0], '状态\n• 未核实：3');
  const update = rest.calls.find(c => c.method === 'PUT')!;
  assert.equal(JSON.parse(JSON.parse(update.body).content).text, '状态\n1. 工作：排版\n   状态：已检查');
});

test('A9: formatted outbox delivery is sent once across replay/restart; original source remains stored', async t => {
  const { f, rest, real } = await transports(t);
  let store = new Store(f.config); t.after(() => store.close());
  const text = '# 状态\n**待核实**：a*b、a|b、/tmp/file_name.txt\n`echo a|b`';
  const first = await deliver(store, real, 'input', 'stable-format-key', text);
  assert.equal(first.status, 'sent');
  assert.deepEqual(await deliver(store, real, 'input', 'stable-format-key', text), first);
  store.close(); store = new Store(f.config);
  assert.deepEqual(await deliver(store, real, 'input', 'stable-format-key', '**不得重发**'), first);
  assert.equal(sends(rest).length, 1);
  assert.equal(JSON.parse(JSON.parse(sends(rest)[0]!.body).content).text, '状态\n待核实：a*b、a|b、/tmp/file_name.txt\necho a|b');
  assert.equal(store.db.prepare('SELECT text FROM outbox WHERE id=?').get('stable-format-key')!.text, text);
  assert.equal(JSON.parse(sends(rest)[0]!.body).msg_type, 'text', 'no added confirmation card');
  assert.equal(store.taskTable().length, 0);
});

test('A9: formatted SDK send timeout stays uncertain after replay/restart, with no retry', async t => {
  const { f, rest, real } = await transports(t, 250); rest.stall('send');
  let store = new Store(f.config); t.after(() => store.close());
  const text = '# 未核实\n- **仅一次**：a*b';
  const started = Date.now();
  assert.equal((await deliver(store, real, 'input', 'uncertain-format-key', text)).status, 'uncertain');
  assert.ok(Date.now() - started < 1500); await until(() => rest.closed === 1);
  assert.equal((await deliver(store, real, 'input', 'uncertain-format-key', text)).status, 'uncertain');
  store.close(); store = new Store(f.config); rest.stall(null);
  assert.equal((await deliver(store, real, 'input', 'uncertain-format-key', text)).status, 'uncertain');
  await sleep(200); assert.equal(sends(rest).length, 1);
  assert.equal(JSON.parse(JSON.parse(sends(rest)[0]!.body).content).text, '未核实\n• 仅一次：a*b');
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get('uncertain-format-key')!.state, 'sending');
});

test('compatibility: task cards bypass prose formatting; buttons, PATCH and attachments remain intact', async t => {
  const { f, rest, fake, real } = await transports(t);
  const card: MessageCard = { title: '# 原卡标题', text: '**原卡正文**\n| 原样 |', buttons: [
    { label: '好', value: { pa: 'worker', token: 'synthetic-token' } },
    { label: '合入', value: { pa: 'unavailable' }, disabled: true },
  ] };
  const id = await real.sendCard!(card, 'card'); await real.updateCard!(id, card);
  const created = JSON.parse(sends(rest)[0]!.body), payload = JSON.parse(created.content);
  assert.equal(created.msg_type, 'interactive'); assert.equal(payload.header.title.content, card.title);
  assert.equal(payload.elements[0].text.tag, 'plain_text'); assert.equal(payload.elements[0].text.content, card.text);
  const actions = payload.elements.filter((e: any) => e.tag === 'action').flatMap((e: any) => e.actions);
  assert.deepEqual(actions.map((a: any) => a.value), [{ pa: 'worker', token: 'synthetic-token' }]);
  assert.ok(JSON.stringify(payload).includes('当前不可用，请回电脑操作'));
  assert.deepEqual(JSON.parse(JSON.parse(rest.calls.find(c => c.method === 'PATCH')!.body).content), payload);
  const fakeId = await fake.sendCard!(card, 'fake-card'); await fake.updateCard!(fakeId, card);
  assert.deepEqual(f.feishu.messages[0]!.card, card); assert.equal(f.feishu.messages[0]!.text, card.text);
  const target = join(f.root, 'attachment.txt');
  await real.download({ id: 'attachment', source: 'feishu', who: 'owner', at: new Date().toISOString(), text: '', messageId: 'message', attachments: [] },
    { kind: 'file', name: 'note.txt', key: 'file' }, target);
  assert.equal(await readFile(target, 'utf8'), 'complete synthetic attachment');
});
