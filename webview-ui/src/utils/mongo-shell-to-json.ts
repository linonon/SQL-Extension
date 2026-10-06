// webview 端的 shell 写法展示 / 复制辅助. mongosh 写法转 EJSON 在 src/utils/mongo-shell-syntax (宿主共用)

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
