import type { IDatabaseDriver } from '../types/driver.js';

const PAGE_SIZE = 1000;

function escapeValue(value: unknown): string {
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
  // string 转义: 单引号和反斜杠
  const str = String(value).replace(/\\/g, '\\\\').replace(/'/g, "''");
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
    const ddl = await driver.getTableDDL(database, table);
    const header = `-- Dump from SQL Extension\n-- Table: ${table}\n-- Date: ${new Date().toISOString()}\n`;
    const dropStmt = driver.driverType === 'mysql'
      ? `DROP TABLE IF EXISTS \`${table.replace(/`/g, '``')}\`;`
      : `DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}";`;
    return `${header}\n${dropStmt}\n\n${ddl}\n`;
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

    // 获取总行数
    const countResult = await driver.execute(
      driver.driverType === 'mysql'
        ? `SELECT COUNT(*) as cnt FROM \`${database.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\``
        : `SELECT COUNT(*) as cnt FROM "${table.replace(/"/g, '""')}"`
    );
    const total = Number(countResult.rows[0]?.cnt ?? 0);

    if (total === 0) {
      return structSql;
    }

    const columns = await driver.listColumns(database, table);
    const colNames = columns.map((c) =>
      driver.driverType === 'mysql'
        ? `\`${c.name.replace(/`/g, '``')}\``
        : `"${c.name.replace(/"/g, '""')}"`
    );

    const qualifiedTable = driver.driverType === 'mysql'
      ? `\`${database.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\``
      : `"${table.replace(/"/g, '""')}"`;

    const parts: string[] = [structSql, ''];
    let offset = 0;

    while (offset < total) {
      if (cancellationToken?.isCancellationRequested) {
        break;
      }

      const result = await driver.execute(
        `SELECT * FROM ${qualifiedTable} LIMIT ${PAGE_SIZE} OFFSET ${offset}`
      );

      if (result.rows.length === 0) {
        break;
      }

      const tableLiteral = driver.driverType === 'mysql'
        ? `\`${table.replace(/`/g, '``')}\``
        : `"${table.replace(/"/g, '""')}"`;

      const valueRows = result.rows.map((row) => {
        const values = columns.map((col) => escapeValue(row[col.name]));
        return `(${values.join(', ')})`;
      });

      parts.push(`INSERT INTO ${tableLiteral} (${colNames.join(', ')}) VALUES\n${valueRows.join(',\n')};\n`);

      offset += result.rows.length;
      onProgress?.(Math.min(offset, total), total);
    }

    return parts.join('\n');
  }
}
