import type { ColumnInfo } from '../types/database';
import { escapeIdentifier } from '../../../src/utils/sql-builder';
import { sqlLiteral } from '../../../src/utils/sql-literal';

// 结果行转成 INSERT 语句, 每行一条. 表名不带库名: 复制出来是要贴到别的库 / 环境执行的
export function buildInsertSql(
  driverType: string,
  table: string,
  columns: readonly ColumnInfo[],
  rows: readonly Record<string, unknown>[]
): string {
  const target = escapeIdentifier(driverType, table);
  const names = columns.map((c) => escapeIdentifier(driverType, c.name)).join(', ');
  const mysql = driverType === 'mysql';
  return rows
    .map((row) => `INSERT INTO ${target} (${names}) VALUES (${columns.map((c) => sqlLiteral(row[c.name], mysql)).join(', ')});`)
    .join('\n');
}
