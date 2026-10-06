import { describe, it, expect } from 'vitest';
import { sortLoadedRows } from './sort-rows';

describe('sortLoadedRows', () => {
  it('数字列按数值排 (BIGINT 字符串不丢精度), NULL 两个方向都在最后', () => {
    const rows = [{ v: '9007199254740993' }, { v: null }, { v: '10' }, { v: '9007199254740992' }, { v: '-2.5' }];
    expect(sortLoadedRows(rows, { column: 'v', direction: 'ASC' }).map((r) => r.v))
      .toEqual(['-2.5', '10', '9007199254740992', '9007199254740993', null]);
    expect(sortLoadedRows(rows, { column: 'v', direction: 'DESC' }).map((r) => r.v))
      .toEqual(['9007199254740993', '9007199254740992', '10', '-2.5', null]);
  });

  it('文本列按字符串排; 相等时保持原顺序 (稳定); 不改原数组', () => {
    const rows = [{ k: 'b', i: 1 }, { k: 'a', i: 2 }, { k: 'b', i: 3 }, { k: '10', i: 4 }];
    expect(sortLoadedRows(rows, { column: 'k', direction: 'ASC' }).map((r) => r.i)).toEqual([4, 2, 1, 3]);
    expect(rows.map((r) => r.i)).toEqual([1, 2, 3, 4]);
  });
});
