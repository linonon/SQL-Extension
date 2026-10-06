import { describe, it, expect } from 'vitest';
import { generateCsv, generateTsv } from './csv';
import type { ColumnInfo } from '../../../src/types/query';

const col = (name: string): ColumnInfo => ({ name, dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' });

describe('generateCsv', () => {
  it('UTF-8 BOM 开头, 含逗号 / 引号 / 换行的字段加引号, NULL 输出空', () => {
    const csv = generateCsv([col('name'), col('note')], [{ name: '张三', note: 'a,"b"\nc' }, { name: null, note: 'x' }]);
    expect(csv).toBe('\uFEFFname,note\r\n张三,"a,""b""\nc"\r\n,x');
  });

  it('TSV: 带表头, 无 BOM, 含 tab / 换行 / 引号的字段加引号, 逗号不加', () => {
    const tsv = generateTsv([col('name'), col('note')], [{ name: 'a\tb', note: 'x\ny' }, { name: null, note: '"q",r' }]);
    expect(tsv).toBe('name\tnote\n"a\tb"\t"x\ny"\n\t"""q"",r"');
  });
});
