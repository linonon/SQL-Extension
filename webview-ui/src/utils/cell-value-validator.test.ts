import { describe, it, expect } from 'vitest';
import { validateCellValue, validateRow } from './cell-value-validator';
import type { ColumnInfo } from '../types/database';

function col(overrides: Partial<ColumnInfo>): ColumnInfo {
  return {
    name: 'c', dataType: 'varchar(50)', nullable: true,
    isPrimaryKey: false, defaultValue: null, extra: '',
    ...overrides,
  };
}

describe('validateCellValue', () => {
  describe('数字列', () => {
    const intCol = col({ name: 'age', dataType: 'int' });
    it('合法数字通过', () => {
      expect(validateCellValue(intCol, '42')).toBeNull();
      expect(validateCellValue(intCol, '-3')).toBeNull();
      expect(validateCellValue(intCol, '  18  ')).toBeNull();
      expect(validateCellValue(col({ dataType: 'decimal(10,2)' }), '12.50')).toBeNull();
    });
    it('非数字拦截 (ISODate-class: 非法值静默写 0)', () => {
      expect(validateCellValue(intCol, 'abc')).toMatch(/需要数字/);
      expect(validateCellValue(intCol, '12,50')).toMatch(/需要数字/);
      expect(validateCellValue(intCol, 'Infinity')).toMatch(/需要数字/);
    });
  });

  describe('日期列', () => {
    const dateCol = col({ name: 'd', dataType: 'date' });
    it('合法日期通过', () => {
      expect(validateCellValue(dateCol, '2026-06-20')).toBeNull();
      expect(validateCellValue(col({ dataType: 'datetime' }), '2026-06-20 12:00:00')).toBeNull();
    });
    it('非法日历日期拦截 (正是 ISODate 那类 bug)', () => {
      expect(validateCellValue(dateCol, '2026-13-99')).toMatch(/日期非法/);
      expect(validateCellValue(dateCol, '2026-02-30')).toMatch(/日期非法/);
    });
    it('不像日期的串放行 (交给 DB, 避免误伤奇异格式)', () => {
      expect(validateCellValue(dateCol, 'now')).toBeNull();
    });
  });

  describe('NOT NULL', () => {
    it('NOT NULL 非自增列空值拦截', () => {
      const c = col({ name: 'x', nullable: false, dataType: 'varchar(20)' });
      expect(validateCellValue(c, '')).toMatch(/不可为空/);
      expect(validateCellValue(c, null)).toMatch(/不可为空/);
    });
    it('NOT NULL 自增列空值放行 (交给 DB)', () => {
      const c = col({ name: 'id', nullable: false, dataType: 'int', extra: 'auto_increment' });
      expect(validateCellValue(c, '')).toBeNull();
    });
    it('nullable 列空值放行', () => {
      expect(validateCellValue(col({ nullable: true }), '')).toBeNull();
    });
  });

  it('非数字/日期列不校验值 (varchar/text 放行)', () => {
    expect(validateCellValue(col({ dataType: 'text' }), 'anything 123 !@#')).toBeNull();
  });
});

describe('validateRow', () => {
  const columns: ColumnInfo[] = [
    col({ name: 'id', dataType: 'int', extra: 'auto_increment', nullable: false }),
    col({ name: 'age', dataType: 'int' }),
    col({ name: 'name', dataType: 'varchar(50)' }),
  ];
  it('只校验 row 中存在的 key', () => {
    expect(validateRow(columns, { age: '30', name: 'A' })).toBeNull();
  });
  it('返回首个错误', () => {
    expect(validateRow(columns, { age: 'oops' })).toMatch(/需要数字/);
  });
});
