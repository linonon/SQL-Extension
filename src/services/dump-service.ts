import type { IDatabaseDriver } from '../types/driver.js';
import { pgSequenceOfDefault } from '../utils/sql-builder.js';

const PAGE_SIZE = 1000;

// 字面量按方言转义: MySQL 字符串里反斜杠是转义符, 要加倍; PG (standard_conforming_strings, 9.1 起默认 on)
// 反斜杠是普通字符, 只双写单引号. 二进制输出 hex 字面量, 不按 utf8 硬解
function escapeValue(value: unknown, mysql: boolean): string {
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
  if (Buffer.isBuffer(value)) {
    return mysql ? `X'${value.toString('hex')}'` : `'\\x${value.toString('hex')}'::bytea`;
  }
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const str = mysql ? raw.replace(/\\/g, '\\\\').replace(/'/g, "''") : raw.replace(/'/g, "''");
  return `'${str}'`;
}

export class DumpService {
  async dumpStruct(
    driver: IDatabaseDriver,
    database: string,
    table: string
  ): Promise<string> {
    if (driver.driverType === 'mongodb') {
      throw new Error('MongoDB does not support SQL dump');
    }
    const ddl = (await driver.getTableDDL(database, table)).trimEnd();
    const header = `-- Dump from SQL Extension\n-- Table: ${table}\n-- Date: ${new Date().toISOString()}\n`;
    const dropStmt = driver.driverType === 'mysql'
      ? `DROP TABLE IF EXISTS \`${table.replace(/`/g, '``')}\`;`
      : `DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}";`;
    // MySQL SHOW CREATE TABLE 不带结尾分号, 补上才能被导入时按 ; 切开
    return `${header}\n${dropStmt}\n\n${ddl.endsWith(';') ? ddl : `${ddl};`}\n`;
  }

  async dumpStructAndData(
    driver: IDatabaseDriver,
    database: string,
    table: string,
    onProgress?: (current: number, total: number) => void,
    cancellationToken?: { readonly isCancellationRequested: boolean }
  ): Promise<string> {
    if (driver.driverType === 'mongodb') {
      throw new Error('MongoDB does not support SQL dump');
    }
    const structSql = await this.dumpStruct(driver, database, table);

    const mysql = driver.driverType === 'mysql';
    const quote = (name: string) => mysql ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
    const qualifiedTable = mysql ? `${quote(database)}.${quote(table)}` : quote(table);

    const countResult = await driver.execute(`SELECT COUNT(*) as cnt FROM ${qualifiedTable}`, undefined, database);
    const total = Number(countResult.rows[0]?.cnt ?? 0);

    if (total === 0) {
      return structSql;
    }

    const columns = await driver.listColumns(database, table);
    const colNames = columns.map((c) => quote(c.name));
    // 按主键分页: 没有 ORDER BY 时 LIMIT/OFFSET 的各页可能重叠或漏行
    const pk = columns.filter((c) => c.isPrimaryKey).map((c) => quote(c.name));
    const orderBy = pk.length > 0 ? ` ORDER BY ${pk.join(', ')}` : '';

    const parts: string[] = [structSql, ''];
    let offset = 0;

    while (offset < total) {
      const result = await driver.execute(
        `SELECT * FROM ${qualifiedTable}${orderBy} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
        undefined,
        database
      );
      // 取消即抛错 (含最后一页期间取消), 调用方不写文件: 半截 dump 没有截断标记, 不能当成备份交出去
      if (cancellationToken?.isCancellationRequested) {
        throw new Error('Dump cancelled');
      }

      if (result.rows.length === 0) {
        break;
      }

      const valueRows = result.rows.map((row) => {
        const values = columns.map((col) => escapeValue(row[col.name], mysql));
        return `(${values.join(', ')})`;
      });

      parts.push(`INSERT INTO ${quote(table)} (${colNames.join(', ')}) VALUES\n${valueRows.join(',\n')};\n`);

      offset += result.rows.length;
      onProgress?.(Math.min(offset, total), total);
    }

    // PG 序列列: 导入的显式值不推进序列, 推到 MAX, 否则之后按默认值插入会撞已导入的主键.
    // 只往前推不回退: 序列可能被别的表共用
    if (!mysql) {
      for (const col of columns) {
        const seq = pgSequenceOfDefault(col.defaultValue);
        if (seq) {
          parts.push(`SELECT setval('${seq.replace(/'/g, "''")}', GREATEST(MAX(${quote(col.name)}), (SELECT last_value FROM ${seq}))) FROM ${quote(table)};\n`);
        }
      }
    }

    return parts.join('\n');
  }
}
