import { describe, it, expect } from 'vitest';
import { widestCellSample, MAX_FIT_CHARS } from './column-fit';

describe('widestCellSample', () => {
  it('选字符数最长的显示字符串 (内容驱动, 不依赖渲染顺序)', () => {
    const rows = [{ a: 'x' }, { a: 'xyz' }, { a: 'xy' }];
    expect(widestCellSample(rows, 'a')).toBe('xyz');
  });

  it('NULL / undefined 按 "NULL" 文本计宽', () => {
    expect(widestCellSample([{ a: null }], 'a')).toBe('NULL');
    expect(widestCellSample([{ b: 1 }], 'a')).toBe('NULL'); // 该列缺值 -> undefined -> 'NULL'
  });

  it('数字等非字符串转字符串测宽', () => {
    expect(widestCellSample([{ a: 12345 }, { a: 1 }], 'a')).toBe('12345');
  });

  it('超长内容截断到上限 (默认 128 字符)', () => {
    const long = 'a'.repeat(500);
    expect(widestCellSample([{ a: long }], 'a')).toHaveLength(MAX_FIT_CHARS);
  });

  it('自定义上限', () => {
    expect(widestCellSample([{ a: 'abcdefgh' }], 'a', 3)).toBe('abc');
  });

  it('空结果集返回空串 (列宽回退到表头宽度)', () => {
    expect(widestCellSample([], 'a')).toBe('');
  });
});
