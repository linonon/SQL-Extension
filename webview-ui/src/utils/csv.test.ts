import { describe, it, expect } from 'vitest';
import { generateCsv } from './csv';
import type { ColumnInfo } from '../types/database';

const col = (name: string): ColumnInfo => ({ name, dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' });

describe('generateCsv', () => {
  it('UTF-8 BOM 开头, 含逗号 / 引号 / 换行的字段加引号, NULL 输出空', () => {
    const csv = generateCsv([col('name'), col('note')], [{ name: '张三', note: 'a,"b"\nc' }, { name: null, note: 'x' }]);
    expect(csv).toBe('\uFEFFname,note\r\n张三,"a,""b""\nc"\r\n,x');
  });
});
