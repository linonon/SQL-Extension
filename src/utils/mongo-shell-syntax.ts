// mongosh 写法 -> Extended JSON 文本的纯文本转换, 宿主与 webview 共用这一份.
// 不 import mongodb / bson / node 模块: webview 直接 import 本文件

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

// ISODate 里没写时区的日期时间按 UTC 解释 (mongosh 语义): 空格换成 T 再补 Z.
// 纯日期本来就按 UTC; new Date("..") 不经此处, 与 mongosh 一样按本地时区
const ZONELESS_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const isoDateUtc = (iso: string): string => iso.replace(ZONELESS_DATETIME, '$1T$2Z');

// 参数的引号单双都收, mongosh 两种都能写
const SHELL_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replace: (...args: string[]) => string;
}> = [
  { pattern: /ObjectId\(\s*["']([0-9a-fA-F]{24})["']\s*\)/, replace: (_, id) => `{"$oid":"${id}"}` },
  { pattern: /ISODate\(\s*["']([^"']+)["']\s*\)/, replace: (_, iso) => `{"$date":"${isoDateUtc(iso)}"}` },
  { pattern: /ISODate\(\s*\)/, replace: () => `{"$date":"${new Date().toISOString()}"}` },
  { pattern: /new\s+Date\(\s*["']([^"']+)["']\s*\)/, replace: (_, iso) => `{"$date":"${iso}"}` },
  { pattern: /new\s+Date\(\s*\)/, replace: () => `{"$date":"${new Date().toISOString()}"}` },
  { pattern: /NumberLong\(\s*["'](-?\d+)["']\s*\)/, replace: (_, n) => `{"$numberLong":"${n}"}` },
  { pattern: /NumberLong\(\s*(-?\d+)\s*\)/, replace: (_, n) => `{"$numberLong":"${n}"}` },
  { pattern: /Long\(\s*["'](-?\d+)["']\s*\)/, replace: (_, n) => `{"$numberLong":"${n}"}` },
  { pattern: /Long\(\s*(-?\d+)\s*\)/, replace: (_, n) => `{"$numberLong":"${n}"}` },
  { pattern: /NumberInt\(\s*(-?\d+)\s*\)/, replace: (_, n) => `{"$numberInt":"${n}"}` },
  { pattern: /Int32\(\s*(-?\d+)\s*\)/, replace: (_, n) => `{"$numberInt":"${n}"}` },
  { pattern: /NumberDecimal\(\s*["']([^"']+)["']\s*\)/, replace: (_, n) => `{"$numberDecimal":"${n}"}` },
  { pattern: /Decimal128\(\s*["']([^"']+)["']\s*\)/, replace: (_, n) => `{"$numberDecimal":"${n}"}` },
  { pattern: /UUID\(\s*["']([0-9a-fA-F-]+)["']\s*\)/, replace: (_, u) => `{"$uuid":"${u}"}` },
  {
    pattern: /BinData\(\s*(\d+)\s*,\s*["']([A-Za-z0-9+/=]*)["']\s*\)/,
    replace: (_, sub, b64) => `{"$binary":{"base64":"${b64}","subType":${sub}}}`,
  },
  { pattern: /Timestamp\(\s*(\d+)\s*,\s*(\d+)\s*\)/, replace: (_, t, i) => `{"$timestamp":{"t":${t},"i":${i}}}` },
  { pattern: /MinKey\(\s*\)/, replace: () => '{"$minKey":1}' },
  { pattern: /MaxKey\(\s*\)/, replace: () => '{"$maxKey":1}' },
];
const SHELL_TAGS = SHELL_PATTERNS.map(({ pattern, replace }) => ({ whole: new RegExp(`^(?:${pattern.source})$`), replace }));

// 一次扫描, 按位置先到先得: 字符串字面量整段吃掉 (其中的 shell 写法 / key / 数字都不改), 其余才改写.
// 裸 key 只补 JS 标识符 (mongosh 里带 . 的路径同样要加引号); 裸整数前后不接标识符 / 小数点 / 指数
const TOKEN = new RegExp([
  /"(?:[^"\\]|\\.)*"/.source,
  /'(?:[^'\\]|\\.)*'/.source,
  ...SHELL_PATTERNS.map(({ pattern }) => pattern.source),
  /(?<=[{,]\s*)[A-Za-z_$][\w$]*(?=\s*:)/.source,
  /(?<![\w$.+-])-?\d+(?![\w$.])/.source,
].join('|'), 'g');

// 单引号字符串转双引号: \' 去掉转义, 裸 " 补转义, 其余转义与 JSON 同义原样保留
function doubleQuoted(single: string): string {
  const body = single.slice(1, -1).replace(/\\(.)|"/gs, (m, c: string | undefined) => (c === "'" ? "'" : c !== undefined ? m : '\\"'));
  return `"${body}"`;
}

// 超出 2^53 的裸整数包成 {"$numberLong":"..."}: JSON.parse 会把它静默舍入成邻近的 double.
// 超出 int64 的不可能是 Long, 保持原样按 double 解析
function wrapUnsafeInteger(m: string): string {
  if (Number.isSafeInteger(Number(m))) { return m; }
  const n = BigInt(m);
  return n < INT64_MIN || n > INT64_MAX ? m : `{"$numberLong":"${m}"}`;
}

function rewriteToken(m: string): string {
  if (m[0] === '"') { return m; }
  if (m[0] === "'") { return doubleQuoted(m); }
  if (/^-?\d/.test(m)) { return wrapUnsafeInteger(m); }
  const tag = SHELL_TAGS.find(({ whole }) => whole.test(m));
  return tag ? m.replace(tag.whole, tag.replace) : `"${m}"`;
}

// 一处改写: 原文 at 起 from 个字符, 换成 to 个字符
interface Rewrite { readonly at: number; readonly from: number; readonly to: number; }

function rewriteShell(input: string): { readonly text: string; readonly edits: readonly Rewrite[] } {
  const edits: Rewrite[] = [];
  const text = input.replace(TOKEN, (m: string, ...rest: unknown[]) => {
    const out = rewriteToken(m);
    // 回调参数里第一个 number 是匹配在原文的 offset (捕获组是 string / undefined)
    if (out !== m) { edits.push({ at: rest.find((x) => typeof x === 'number') as number, from: m.length, to: out.length }); }
    return out;
  });
  return { text, edits };
}

// 改写后文本的位置换算回原文; 落在某处改写里的指向该处原文的起点
function originalOffset(edits: readonly Rewrite[], pos: number): number {
  let shift = 0;
  for (const { at, from, to } of edits) {
    if (pos < at + shift) { break; }
    if (pos < at + shift + to) { return at; }
    shift += to - from;
  }
  return pos - shift;
}

/**
 * mongosh 写法转 Extended JSON 文本: ObjectId('..') -> {"$oid":".."}, {uid: 1} -> {"uid": 1},
 * 'abc' -> "abc", 超出 2^53 的裸整数 -> {"$numberLong":".."}. 字符串字面量内的文本不改.
 */
export function convertShellToJson(input: string): string {
  return rewriteShell(input).text;
}

function lineColumn(input: string, offset: number): string {
  const lines = input.slice(0, offset).split('\n');
  return `line ${lines.length} column ${lines[lines.length - 1].length + 1}`;
}

// 字符串字面量之外的 ' 是没闭合的字符串, / 是正则字面量: 两者 V8 都只报 "Unexpected token" 不带位置, 这里自己定位
const STRAY = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(['/])/g;
const STRAY_ERROR: Readonly<Record<string, (at: string) => string>> = {
  "'": (at) => `Unterminated string at ${at}`,
  '/': (at) => `Unexpected "/" at ${at} (regex literals and comments are not supported; use {"$regex": "..."})`,
};

/**
 * 解析 mongosh 写法为 EJSON 对象. 语法错误的位置换算成用户原文的行列;
 * 不带位置的 "Unexpected token" 只留出错的 token (V8 引用的是改写后的文本, 用户没写过),
 * 出错的是未闭合的单引号或正则字面量时报原文行列
 */
export function parseShellJson(input: string): unknown {
  const { text, edits } = rewriteShell(input);
  try {
    return JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const at = /\s*(?:in JSON )?at position (\d+)(?: \(line \d+ column \d+\))?/.exec(message);
    if (at) { throw new SyntaxError(`${message.slice(0, at.index)} at ${lineColumn(input, originalOffset(edits, Number(at[1])))}`); }
    // V8 停在第一个出错处, 字符串之外的第一个 ' 或 / 必然是错; V8 报的正是这个字符时就是它
    const stray = [...input.matchAll(STRAY)].find((m) => m[1]);
    if (stray && message.startsWith(`Unexpected token '${stray[1]}'`)) {
      throw new SyntaxError(STRAY_ERROR[stray[1]](lineColumn(input, stray.index)));
    }
    throw new SyntaxError(message.replace(/, (?:\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s, ''));
  }
}
