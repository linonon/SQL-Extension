// 编辑器语法高亮 + 校验定位的纯逻辑.

export type TokenType = 'key' | 'string' | 'number' | 'keyword' | 'bson' | 'punct' | 'plain';
export interface Token {
  readonly text: string;
  readonly type: TokenType;
}

const BSON_CTORS = new Set([
  'ObjectId', 'ISODate', 'Date', 'NumberLong', 'Long', 'NumberInt', 'Int32',
  'NumberDecimal', 'Decimal128', 'MinKey', 'MaxKey', 'new',
]);

// 把 mongo shell-JSON 文本切成带类型的 token. 不变量: 拼接所有 token.text === 原文 (保证与 textarea 对齐).
export function tokenizeMongoJson(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];

    // 空白 (含换行) 成段
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) { j++; }
      tokens.push({ text: text.slice(i, j), type: 'plain' });
      i = j;
      continue;
    }

    // 字符串 (支持转义); 其后紧跟 ':' 则为 key
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        j++;
      }
      let k = j;
      while (k < n && /\s/.test(text[k])) { k++; }
      tokens.push({ text: text.slice(i, j), type: text[k] === ':' ? 'key' : 'string' });
      i = j;
      continue;
    }

    if ('{}[]:,'.includes(c)) {
      tokens.push({ text: c, type: 'punct' });
      i++;
      continue;
    }

    // 数字 (负号仅当后跟数字才算数字的一部分)
    if (/\d/.test(c) || (c === '-' && /\d/.test(text[i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (m) {
        tokens.push({ text: m[0], type: 'number' });
        i += m[0].length;
        continue;
      }
    }

    // 标识符: keyword / BSON 构造器 / 普通
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))!;
      const word = m[0];
      const type: TokenType =
        word === 'true' || word === 'false' || word === 'null' ? 'keyword'
          : BSON_CTORS.has(word) ? 'bson'
            : 'plain';
      tokens.push({ text: word, type });
      i += word.length;
      continue;
    }

    tokens.push({ text: c, type: 'plain' });
    i++;
  }
  return tokens;
}

// 从 JSON.parse 错误信息映射到行号 (1-based); 无定位信息返回 null.
export function jsonErrorLine(text: string, message: string): number | null {
  if (!message) { return null; }
  const lineM = /line (\d+)/i.exec(message);
  if (lineM) { return Number(lineM[1]); }
  const posM = /position (\d+)/i.exec(message);
  if (posM) {
    const pos = Math.min(Number(posM[1]), text.length);
    let line = 1;
    for (let i = 0; i < pos; i++) { if (text[i] === '\n') { line++; } }
    return line;
  }
  return null;
}
