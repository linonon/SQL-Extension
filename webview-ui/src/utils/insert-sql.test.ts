import { describe, it, expect } from 'vitest';
import { buildInsertSql } from './insert-sql';
import type { ColumnInfo } from '../../../src/types/query';

const col = (name: string): ColumnInfo => ({ name, dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' });

describe('buildInsertSql', () => {
  const columns = [col('id'), col('na`me"'), col('note')];
  const rows = [{ id: 1, 'na`me"': "it's", note: 'C:\\x' }, { id: 2, 'na`me"': null, note: true }];

  it('MySQL: 反引号标识符, 字符串里单引号双写, 反斜杠加倍, 每行一条', () => {
    expect(buildInsertSql('mysql', 'user', columns, rows)).toBe(
      "INSERT INTO `user` (`id`, `na``me\"`, `note`) VALUES (1, 'it''s', 'C:\\\\x');\n" +
      'INSERT INTO `user` (`id`, `na``me"`, `note`) VALUES (2, NULL, TRUE);'
    );
  });

  it('PG: 双引号标识符, 反斜杠是普通字符', () => {
    expect(buildInsertSql('postgresql', 'user', columns, rows.slice(0, 1))).toBe(
      `INSERT INTO "user" ("id", "na\`me""", "note") VALUES (1, 'it''s', 'C:\\x');`
    );
  });
});
