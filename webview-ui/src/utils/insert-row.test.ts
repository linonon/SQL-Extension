import { describe, it, expect } from 'vitest';
import { isAutoFilledColumn, isExpressionDefault, buildInsertRow } from './insert-row';
import type { ColumnInfo } from '../types/database';

function col(overrides: Partial<ColumnInfo>): ColumnInfo {
  return {
    name: 'c', dataType: 'varchar(50)', nullable: true,
    isPrimaryKey: false, defaultValue: null, extra: '',
    ...overrides,
  };
}

describe('isAutoFilledColumn', () => {
  it('MySQL auto_increment', () => {
    expect(isAutoFilledColumn(col({ extra: 'auto_increment' }))).toBe(true);
  });
  it('PostgreSQL serial (default nextval)', () => {
    expect(isAutoFilledColumn(col({ defaultValue: "nextval('users_id_seq'::regclass)" }))).toBe(true);
  });
  it('PostgreSQL identity', () => {
    expect(isAutoFilledColumn(col({ extra: 'identity' }))).toBe(true);
  });
  it('普通列不算', () => {
    expect(isAutoFilledColumn(col({ defaultValue: '0' }))).toBe(false);
  });
});

describe('isExpressionDefault', () => {
  it('CURRENT_TIMESTAMP / now() / gen_random_uuid()', () => {
    expect(isExpressionDefault('CURRENT_TIMESTAMP')).toBe(true);
    expect(isExpressionDefault('now()')).toBe(true);
    expect(isExpressionDefault('gen_random_uuid()')).toBe(true);
  });
  it('字面量不算表达式', () => {
    expect(isExpressionDefault('active')).toBe(false);
    expect(isExpressionDefault('0')).toBe(false);
    expect(isExpressionDefault('')).toBe(false);
  });
});

describe('buildInsertRow', () => {
  it('省略自增列与表达式默认值列, 预填字面量默认值', () => {
    const columns: ColumnInfo[] = [
      col({ name: 'id', extra: 'auto_increment', isPrimaryKey: true }),
      col({ name: 'created', dataType: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' }),
      col({ name: 'status', defaultValue: 'active' }),
      col({ name: 'note', defaultValue: null }),
    ];
    const row = buildInsertRow(columns);
    // id (自增), created (表达式), note (无默认) 都省略; 只预填字面量默认值
    expect(row).toEqual({ status: 'active' });
    expect('id' in row).toBe(false);
    expect('created' in row).toBe(false);
    expect('note' in row).toBe(false);
  });

  it('全部列由 DB 填充时返回空 row (insert all defaults)', () => {
    const columns: ColumnInfo[] = [
      col({ name: 'id', defaultValue: "nextval('s'::regclass)" }),
      col({ name: 'ts', defaultValue: 'now()' }),
    ];
    expect(buildInsertRow(columns)).toEqual({});
  });
});
