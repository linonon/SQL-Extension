// 编辑器语法高亮 + 校验定位的纯逻辑.

export type TokenType = 'key' | 'string' | 'number' | 'keyword' | 'bson' | 'punct' | 'plain';
export interface Token {
  readonly text: string;
  readonly type: TokenType;
}

const BSON_CTORS = new Set([
  'ObjectId', 'ISODate', 'Date', 'NumberLong', 'Long', 'NumberInt', 'Int32',
  'NumberDecimal', 'Decimal128', 'UUID', 'BinData', 'Timestamp', 'MinKey', 'MaxKey', 'new',
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

// text[idx] 所在行号 (1-based)
export function lineOfIndex(text: string, idx: number): number {
  const end = Math.min(idx, text.length);
  let line = 1;
  for (let i = 0; i < end; i++) { if (text[i] === '\n') { line++; } }
  return line;
}

// 从 JSON.parse 错误信息映射到行号 (1-based); 无定位信息返回 null.
export function jsonErrorLine(text: string, message: string): number | null {
  if (!message) { return null; }
  const lineM = /line (\d+)/i.exec(message);
  if (lineM) { return Number(lineM[1]); }
  const posM = /position (\d+)/i.exec(message);
  if (posM) { return lineOfIndex(text, Number(posM[1])); }
  return null;
}

export interface EjsonProblem { readonly marker: string; readonly value: string; readonly message: string; }

// 必须与后端 EJSON_CONVERTERS (src/utils/mongo-shell-to-json.ts) 的接受值集一致, 否则前端放行 / 后端抛错.
const EJSON_MARKERS = new Set([
  '$oid', '$date', '$numberLong', '$numberInt', '$numberDecimal',
  '$uuid', '$binary', '$timestamp', '$minKey', '$maxKey',
]);
const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function outOfRange(s: string, min: bigint, max: bigint): boolean {
  try { const b = BigInt(s); return b < min || b > max; } catch { return true; }
}

// 校验 EJSON 标记的"值"合法性 (JSON 语法合法但 BSON 值非法的情况, 如 ISODate 写错日期 / 整数越界).
// 返回首个问题, 否则 null. 防止非法值静默写库 (非法日期变 epoch 0, 越界整数被回绕).
export function validateEjsonValues(obj: unknown): EjsonProblem | null {
  const walk = (v: unknown): EjsonProblem | null => {
    if (Array.isArray(v)) {
      for (const x of v) { const p = walk(x); if (p) { return p; } }
      return null;
    }
    if (v === null || typeof v !== 'object') { return null; }
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec);
    // EJSON 标记与其他字段共存即畸形 wrapper (后端按字面子文档处理 / Mongo 拒绝 $ 字段名).
    const markerKey = keys.find((k) => EJSON_MARKERS.has(k));
    if (markerKey && keys.length > 1) {
      return { marker: markerKey, value: markerKey, message: `EJSON 标记 ${markerKey} 不能与其他字段共存` };
    }
    if (keys.length === 1) {
      const k = keys[0];
      const val = rec[k];
      const s = String(val);
      if (k === '$date') {
        const d = typeof val === 'number' ? new Date(val) : new Date(s);
        if (Number.isNaN(d.getTime())) { return { marker: k, value: s, message: `无效日期: "${s}"` }; }
      } else if (k === '$oid') {
        if (!/^[0-9a-fA-F]{24}$/.test(s)) { return { marker: k, value: s, message: `无效 ObjectId (需 24 位 hex): "${s}"` }; }
      } else if (k === '$numberInt') {
        if (!/^-?\d+$/.test(s)) { return { marker: k, value: s, message: `无效整数: "${s}"` }; }
        if (outOfRange(s, INT32_MIN, INT32_MAX)) { return { marker: k, value: s, message: `整数超出 int32 范围: "${s}"` }; }
      } else if (k === '$numberLong') {
        if (!/^-?\d+$/.test(s)) { return { marker: k, value: s, message: `无效整数: "${s}"` }; }
        if (outOfRange(s, INT64_MIN, INT64_MAX)) { return { marker: k, value: s, message: `整数超出 int64 范围: "${s}"` }; }
      } else if (k === '$numberDecimal') {
        const t = s.trim();
        if (!(DECIMAL_RE.test(t) || /^[+-]?Infinity$/i.test(t) || /^NaN$/i.test(t))) {
          return { marker: k, value: s, message: `无效数字: "${s}"` };
        }
      } else if (k === '$uuid') {
        if (!/^[0-9a-fA-F]{32}$/.test(s.replace(/-/g, ''))) { return { marker: k, value: s, message: `无效 UUID: "${s}"` }; }
      }
    }
    for (const key of keys) { const p = walk(rec[key]); if (p) { return p; } }
    return null;
  };
  return walk(obj);
}
