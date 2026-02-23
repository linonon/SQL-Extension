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
  { pattern: /NumberLong\(\s*"(\d+)"\s*\)/g, replace: '{"$$numberLong":"$1"}' },
  { pattern: /NumberLong\(\s*(\d+)\s*\)/g, replace: '{"$$numberLong":"$1"}' },
  { pattern: /NumberInt\(\s*(\d+)\s*\)/g, replace: '{"$$numberInt":"$1"}' },
  { pattern: /NumberDecimal\(\s*"([^"]+)"\s*\)/g, replace: '{"$$numberDecimal":"$1"}' },
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
    .replace(/NumberLong\(\s*"(\d+)"\s*\)/g, '$1')
    .replace(/NumberLong\(\s*(\d+)\s*\)/g, '$1')
    .replace(/NumberInt\(\s*(\d+)\s*\)/g, '$1')
    .replace(/NumberDecimal\(\s*"([^"]*)"\s*\)/g, '$1')
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
    .replace(/"NumberLong\(\\"(\d+)\\"\)"/g, 'NumberLong("$1")')
    .replace(/"NumberInt\((\d+)\)"/g, 'NumberInt($1)')
    .replace(/"NumberDecimal\(\\"([^"]*)\\"\)"/g, 'NumberDecimal("$1")')
    .replace(/"MinKey\(\)"/g, 'MinKey()')
    .replace(/"MaxKey\(\)"/g, 'MaxKey()');
}
