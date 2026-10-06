import type { ColumnInfo } from '../types/database';

// RFC 4180: 字段包含分隔符, 双引号, 换行时需要用双引号包裹, 内部双引号转义为两个双引号
function escapeField(value: unknown, separator: string): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(separator) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function joinRows(
  columns: readonly ColumnInfo[],
  rows: readonly Record<string, unknown>[],
  separator: string,
  newline: string
): string {
  const header = columns.map((col) => escapeField(col.name, separator)).join(separator);
  const body = rows.map((row) =>
    columns.map((col) => escapeField(row[col.name], separator)).join(separator)
  );
  return [header, ...body].join(newline);
}

// 开头带 UTF-8 BOM: Excel 没有 BOM 时按本地编码打开, 中文会乱码
export function generateCsv(
  columns: readonly ColumnInfo[],
  rows: readonly Record<string, unknown>[]
): string {
  return '\uFEFF' + joinRows(columns, rows, ',', '\r\n');
}

// 复制到剪贴板的 TSV (带表头): 贴进表格软件按列拆开, 含 tab / 换行的字段同 CSV 规则加引号
export function generateTsv(
  columns: readonly ColumnInfo[],
  rows: readonly Record<string, unknown>[]
): string {
  return joinRows(columns, rows, '\t', '\n');
}
