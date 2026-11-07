// A deliberately small Markdown-to-text adapter, not a Markdown renderer.
// Only presentation delimiters we can identify safely are removed.
function codeSpan(text: string, start: number) {
  const marker = /^`+/.exec(text.slice(start))![0];
  let end = start + marker.length;
  while ((end = text.indexOf(marker, end)) !== -1) {
    if (text[end - 1] !== '`' && text[end + marker.length] !== '`') return { marker, end: end + marker.length };
    end += marker.length;
  }
}
function inline(text: string, unclosed?: (marker: string) => void): string {
  // Hide literals before touching emphasis; choose a marker absent from the input.
  let marker = '\u0000'; while (text.includes(marker)) marker += '\u0000';
  const literals: string[] = [];
  const keep = (value: string) => `${marker}${literals.push(value) - 1}${marker}`;
  let value = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && i + 1 < text.length) { value += keep(text.slice(i, i + 2)); i += 2; continue; }
    if (text[i] === '`') {
      const span = codeSpan(text, i);
      if (!span) { unclosed?.(/^`+/.exec(text.slice(i))![0]); value += keep(text.slice(i)); break; }
      value += keep(text.slice(i + span.marker.length, span.end - span.marker.length)); i = span.end; continue;
    }
    // Simple inline links, including one balanced pair of parentheses in the URL.
    const link = /^(!?)\[([^\[\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/.exec(text.slice(i));
    if (link) {
      value += keep(link[1] ? link[0] : `${inline(link[2]!)}（${link[3]}）`); i += link[0].length; continue;
    }
    const urlStart = i === 0 || !/[a-z\d+.-]/i.test(text[i - 1]!);
    const url = urlStart ? /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:)[^\s<>]+/i.exec(text.slice(i)) : null;
    if (url) {
      let literal = url[0];
      const wrapper = /(\*{1,3}|_{1,3})$/.exec(text.slice(0, i))?.[0];
      if (wrapper && literal.endsWith(wrapper)) literal = literal.slice(0, -wrapper.length);
      value += keep(literal); i += literal.length; continue;
    }
    // Paths/filenames can contain paired underscores (including Chinese names).
    // Probe only at token boundaries, not every suffix of a long prose word.
    const pathStart = i === 0 || !/[\p{L}\p{N}_./\\-]/u.test(text[i - 1]!);
    const path = pathStart ? /^(?:[a-z]:[\\/][^\s<>，。；、（）]+|(?:\.{0,2}\/|~\/)[^\s<>，。；、（）]+|[\p{L}\p{N}_.-]+(?:[\\/][\p{L}\p{N}_.-]+)+|[\p{L}\p{N}_-]+\.[a-z\d]+)(?=$|[\s，。；、（）,;)])/iu.exec(text.slice(i)) : null;
    if (path) {
      let literal = path[0];
      const wrapper = /(\*{1,3}|_{1,3})$/.exec(text.slice(0, i))?.[0];
      if (wrapper && literal.endsWith(wrapper)) literal = literal.slice(0, -wrapper.length);
      value += keep(literal); i += literal.length; continue;
    }
    value += text[i++];
  }
  // ASCII word/path boundaries protect multiplication and embedded underscores.
  // A few passes allow simple nested emphasis, without attempting arbitrary nesting.
  for (let pass = 0; pass < 3; pass++) value = value.replace(/(?<![\w/\\*])(\*{1,3}|_{1,3})(?=[^\s*_])(.+?)\1(?![\w/\\*]|\.\w)/g,
    (raw: string, delimiter: string, body: string, at: number, source: string) => {
      const inWord = /[\p{L}\p{N}]/u.test(source[at - 1] ?? '') || /[\p{L}\p{N}]/u.test(source[at + raw.length] ?? '');
      return /[\s*_]$/.test(body) || (delimiter.length === 1 || delimiter[0] === '_') && inWord ? raw : body;
    });
  return value.replace(new RegExp(`${marker}(\\d+)${marker}`, 'g'), (_raw, n: string) => literals[Number(n)]!);
}
function cells(line: string) {
  const values = ['']; let pipes = 0;
  for (let i = 0; i < line.length;) {
    if (line[i] === '\\' && i + 1 < line.length) {
      values[values.length - 1] += line[i + 1] === '|' ? '|' : line.slice(i, i + 2); i += 2; continue;
    }
    if (line[i] === '`') {
      const span = codeSpan(line, i); if (!span) return;
      values[values.length - 1] += line.slice(i, span.end); i = span.end; continue;
    }
    if (line[i] === '|') { values.push(''); pipes++; i++; continue; }
    values[values.length - 1] = values.at(-1)! + line[i]!; i++;
  }
  if (!pipes) return;
  if (!values[0]!.trim()) values.shift();
  if (!values.at(-1)!.trim()) values.pop();
  return values.map(cell => cell.trim());
}

/** Shared by fake/SDK send and update. Never used for task cards or inbound data. */
export function feishuText(text: string): string {
  // Keep original line endings, whitespace and blank lines outside table layout.
  const parts = text.split(/(\r\n|\n|\r)/), output: string[] = [];
  let openCode: string | undefined;
  for (let i = 0; i < parts.length;) {
    const line = parts[i]!, eol = parts[i + 1] ?? '';
    if (openCode) {
      // Multiline inline code is unsupported: retain complete source lines until
      // its exact closing run (or EOF), rather than interpreting code as prose.
      if (new RegExp(`(?<!\`)${openCode}(?!\`)`).test(line)) openCode = undefined;
      output.push(line, eol); i += 2; continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}[ \\t]*$`);
      let end = i + 2; while (end < parts.length && !close.test(parts[end]!)) end += 2;
      // Unclosed fences are an explicit verbatim fallback, never parsed as prose.
      if (end >= parts.length) { output.push(parts.slice(i).join('')); break; }
      const language = fence[2]!.trim();
      output.push(`代码${language ? `（${language}）` : ''}：`, eol, parts.slice(i + 2, end).join(''), parts[end + 1] ?? '');
      i = end + 2; continue;
    }
    if (/^(?: {4}|\t)/.test(line)) { output.push(line, eol); i += 2; continue; }
    const separator = cells(parts[i + 2] ?? '');
    if (separator?.length && separator.every(cell => /^:?-{3,}:?$/.test(cell)) && line.includes('|')) {
      const header = cells(line), rows: (string[] | undefined)[] = [];
      let end = i + 4;
      while (end < parts.length && parts[end]!.trim() && parts[end]!.includes('|') && !/^(?: {4}|\t| {0,3}(?:`{3,}|~{3,}))/.test(parts[end]!)) {
        rows.push(cells(parts[end]!)); end += 2;
      }
      const newline = eol || '\n', lastEol = parts[end - 1] ?? '';
      if (!header?.length || header.length !== separator.length || header.some(cell => !cell) || !rows.length || rows.some(row => !row || row.length !== header.length)) {
        output.push('表格格式暂不支持，以下保留原文：', newline, parts.slice(i, end).join(''));
      } else {
        output.push(rows.map((row, n) => row!.map((cell, column) => `${column ? '   ' : `${n + 1}. `}${inline(header[column]!)}：${inline(cell)}`).join(newline)).join(newline + newline), lastEol);
      }
      i = end; continue;
    }
    const heading = /^( {0,3})#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    const prose = heading ? heading[1] + heading[2]! : line.replace(/^( {0,3})[-+*][ \t]+(?=\S)/, '$1• ');
    output.push(inline(prose, marker => { openCode = marker; }), eol); i += 2;
  }
  return output.join('');
}
