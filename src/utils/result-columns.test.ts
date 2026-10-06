import { describe, it, expect } from 'vitest';
import { rowObjects, uniqueColumnKeys } from './result-columns';

describe('uniqueColumnKeys', () => {
  it('JOIN 同名列: 首个不变, 之后用表别名限定; 无别名或仍冲突时加序号', () => {
    const keys = uniqueColumnKeys([
      { name: 'id', table: 'u' },
      { name: 'id', table: 'o' },
      { name: 'amount', table: 'o' },
      { name: 'id', table: 'o' },
      { name: 'id' },
    ]);
    expect(keys).toEqual(['id', 'o.id', 'amount', 'id (2)', 'id (3)']);
  });

  it('值数组按 key 组装, 两列 id 都保留', () => {
    const keys = uniqueColumnKeys([{ name: 'id', table: 'u' }, { name: 'id', table: 'o' }]);
    expect(rowObjects(keys, [[1, 99]])).toEqual([{ id: 1, 'o.id': 99 }]);
  });
});
