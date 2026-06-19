// MongoDB shell 语法 <-> JSON 转换 (webview 端, 纯正则, 不依赖 mongodb 包)

const SHELL_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replace: string | ((...args: string[]) => string);
}> = [
  { pattern: /ObjectId\(\s*"([0-9a-fA-F]{24})"\s*\)/g, replace: '{"$$oid":"$1"}' },
  { pattern: /ISODate\(\s*"([^"]+)"\s*\)/g, replace: '{"$$date":"$1"}' },
  { pattern: /ISODate\(\s*\)/g, replace: () => `{"$date":"${new Date().toISOString()}"}` },
  { pattern: /new\s+Date\(\s*"([^"]+)"\s*\)/g, replace: '{"$$date":"$1"}' },
  { pattern: /new\s+Date\(\s*\)/g, replace: () => `{"$date":"${new Date().toISOString()}"}` },
  { pattern: /NumberLong\(\s*"(-?\d+)"\s*\)/g, replace: '{"$$numberLong":"$1"}' },
  { pattern: /NumberLong\(\s*(-?\d+)\s*\)/g, replace: '{"$$numberLong":"$1"}' },
  { pattern: /NumberInt\(\s*(-?\d+)\s*\)/g, replace: '{"$$numberInt":"$1"}' },
  { pattern: /NumberDecimal\(\s*"([^"]+)"\s*\)/g, replace: '{"$$numberDecimal":"$1"}' },
  // 后端别名 (Long/Int32/Decimal128), 与 src/utils/mongo-shell-to-json.ts 对齐, 否则编辑器拒绝后端能认的写法.
  { pattern: /Long\(\s*"(-?\d+)"\s*\)/g, replace: '{"$$numberLong":"$1"}' },
  { pattern: /Long\(\s*(-?\d+)\s*\)/g, replace: '{"$$numberLong":"$1"}' },
  { pattern: /Int32\(\s*(-?\d+)\s*\)/g, replace: '{"$$numberInt":"$1"}' },
  { pattern: /Decimal128\(\s*"([^"]+)"\s*\)/g, replace: '{"$$numberDecimal":"$1"}' },
  { pattern: /UUID\(\s*"([0-9a-fA-F-]+)"\s*\)/g, replace: '{"$$uuid":"$1"}' },
  { pattern: /BinData\(\s*(\d+)\s*,\s*"([A-Za-z0-9+/=]*)"\s*\)/g, replace: (_m, sub, b64) => `{"$binary":{"base64":"${b64}","subType":${sub}}}` },
  { pattern: /Timestamp\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, replace: (_m, t, i) => `{"$timestamp":{"t":${t},"i":${i}}}` },
  { pattern: /MinKey\(\s*\)/g, replace: '{"$minKey":1}' },
  { pattern: /MaxKey\(\s*\)/g, replace: '{"$maxKey":1}' },
];

/**
 * shell 语法转 Extended JSON.
 * ObjectId("abc") -> {"$oid":"abc"}
 */
export function convertShellToJson(input: string): string {
  let result = input;
  for (const { pattern, replace } of SHELL_PATTERNS) {
    // reset lastIndex (RegExp with /g flag)
    pattern.lastIndex = 0;
    result = result.replace(pattern, replace as string);
  }
  return result;
}

/**
 * 去掉 shell 类型包装, 保留纯值. 用于 "Copy as JSON".
 * ObjectId("abc") -> "abc", NumberLong("123") -> 123
 */
export function stripShellTypes(input: string): string {
  return input
    .replace(/ObjectId\(\s*"([^"]*)"\s*\)/g, '"$1"')
    .replace(/ISODate\(\s*"([^"]*)"\s*\)/g, '"$1"')
    .replace(/NumberLong\(\s*"(-?\d+)"\s*\)/g, '$1')
    .replace(/NumberLong\(\s*(-?\d+)\s*\)/g, '$1')
    .replace(/NumberInt\(\s*(-?\d+)\s*\)/g, '$1')
    .replace(/NumberDecimal\(\s*"([^"]*)"\s*\)/g, '$1')
    .replace(/Long\(\s*"(-?\d+)"\s*\)/g, '$1')
    .replace(/Long\(\s*(-?\d+)\s*\)/g, '$1')
    .replace(/Int32\(\s*(-?\d+)\s*\)/g, '$1')
    .replace(/Decimal128\(\s*"([^"]*)"\s*\)/g, '$1')
    .replace(/UUID\(\s*"([0-9a-fA-F-]+)"\s*\)/g, '"$1"')
    .replace(/BinData\(\s*\d+\s*,\s*"([A-Za-z0-9+/=]*)"\s*\)/g, '"$1"')
    .replace(/MinKey\(\s*\)/g, 'null')
    .replace(/MaxKey\(\s*\)/g, 'null');
}

/**
 * JSON.stringify 输出 -> shell 语法展示.
 * 将被引号包裹的 shell 类型字符串还原为无引号的 shell 语法.
 * "ObjectId(\"abc\")" -> ObjectId("abc")
 */
export function jsonToShell(json: string): string {
  return json
    .replace(/"ObjectId\(\\"([^"]*)\\"\)"/g, 'ObjectId("$1")')
    .replace(/"ISODate\(\\"([^"]*)\\"\)"/g, 'ISODate("$1")')
    .replace(/"NumberLong\(\\"(-?\d+)\\"\)"/g, 'NumberLong("$1")')
    .replace(/"NumberInt\((-?\d+)\)"/g, 'NumberInt($1)')
    .replace(/"NumberDecimal\(\\"([^"]*)\\"\)"/g, 'NumberDecimal("$1")')
    .replace(/"UUID\(\\"([0-9a-fA-F-]+)\\"\)"/g, 'UUID("$1")')
    .replace(/"BinData\((\d+),\\"([A-Za-z0-9+/=]*)\\"\)"/g, 'BinData($1,"$2")')
    .replace(/"Timestamp\((\d+),(\d+)\)"/g, 'Timestamp($1,$2)')
    .replace(/"MinKey\(\)"/g, 'MinKey()')
    .replace(/"MaxKey\(\)"/g, 'MaxKey()');
}
