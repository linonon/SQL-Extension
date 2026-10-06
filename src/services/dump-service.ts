import type { IDatabaseDriver } from '../types/driver.js';
import { pgSequenceOfDefault } from '../utils/sql-builder.js';
import { sqlLiteral } from '../utils/sql-literal.js';

const PAGE_SIZE = 1000;
// 单条 INSERT 的字节上限, 同 mysqldump 的 net_buffer_length: 远低于 max_allowed_packet 的常见默认值
const MAX_INSERT_BYTES = 1024 * 1024;

export class DumpService {
  async dumpStruct(
    driver: IDatabaseDriver,
    database: string,
    table: string
  ): Promise<string> {
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

    const insertHead = `INSERT INTO ${quote(table)} (${colNames.join(', ')}) VALUES\n`;
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

      // 按字节数分条, 每条 INSERT 至少一行: 一页行数固定, 大行一页能超过服务端 max_allowed_packet (5.7 默认 4MB)
      let chunk: string[] = [];
      let bytes = 0;
      const flush = () => {
        parts.push(`${insertHead}${chunk.join(',\n')};\n`);
        chunk = [];
        bytes = 0;
      };
      for (const row of result.rows) {
        const tuple = `(${columns.map((col) => sqlLiteral(row[col.name], mysql)).join(', ')})`;
        const size = Buffer.byteLength(tuple) + 2;
        if (chunk.length > 0 && bytes + size > MAX_INSERT_BYTES) { flush(); }
        chunk.push(tuple);
        bytes += size;
      }
      flush();

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
