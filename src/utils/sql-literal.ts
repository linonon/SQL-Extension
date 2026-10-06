// SQL 字面量按方言转义, dump 与结果网格的 Copy as INSERT 共用 (纯函数, webview 直接 import).
// MySQL 字符串里反斜杠是转义符, 要加倍; PG (standard_conforming_strings, 9.1 起默认 on)
// 反斜杠是普通字符, 只双写单引号. 二进制 (Buffer / Uint8Array) 输出 hex 字面量, 不按 utf8 硬解
export function sqlLiteral(value: unknown, mysql: boolean): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }
  if (value instanceof Uint8Array) {
    const hex = Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
    return mysql ? `X'${hex}'` : `'\\x${hex}'::bytea`;
  }
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const str = mysql ? raw.replace(/\\/g, '\\\\').replace(/'/g, "''") : raw.replace(/'/g, "''");
  return `'${str}'`;
}
