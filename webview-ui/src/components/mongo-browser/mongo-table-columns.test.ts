import { describe, it, expect } from 'vitest';
import { getByPath, buildDisplayColumns } from './mongo-table-columns';

const rows = [
  { _id: 'ObjectId("a")', name: 'Alice', bind: { aid: 'w-1', meta: { lvl: 2 } } },
  { _id: 'ObjectId("b")', name: 'Bob', bind: { aid: 'w-2' } },
];

describe('getByPath', () => {
  it('取顶层字段', () => {
    expect(getByPath(rows[0], 'name')).toBe('Alice');
  });
  it('取嵌套 path', () => {
    expect(getByPath(rows[0], 'bind.aid')).toBe('w-1');
    expect(getByPath(rows[0], 'bind.meta.lvl')).toBe(2);
  });
  it('缺失 path -> undefined, 不抛错', () => {
    expect(getByPath(rows[1], 'bind.meta.lvl')).toBeUndefined();
    expect(getByPath(rows[0], 'nope.x')).toBeUndefined();
  });
});

describe('buildDisplayColumns', () => {
  const top = ['_id', 'name', 'bind'];

  it('未展开: 顶层列, object 列标记 expandable', () => {
    const cols = buildDisplayColumns(top, rows, new Set());
    expect(cols.map((c) => c.path)).toEqual(['_id', 'name', 'bind']);
    expect(cols.find((c) => c.path === 'bind')!.expandable).toBe(true);
    expect(cols.find((c) => c.path === 'name')!.expandable).toBe(false);
  });

  it('展开 bind: 替换为 bind.* 列, label 用完整 path, 带 collapseParent', () => {
    const cols = buildDisplayColumns(top, rows, new Set(['bind']));
    expect(cols.map((c) => c.path)).toEqual(['_id', 'name', 'bind.aid', 'bind.meta']);
    const aid = cols.find((c) => c.path === 'bind.aid')!;
    expect(aid.label).toBe('bind.aid');
    expect(aid.collapseParent).toBe('bind');
    // bind.meta 本身是 object -> 仍 expandable
    expect(cols.find((c) => c.path === 'bind.meta')!.expandable).toBe(true);
  });

  it('多层展开: bind 与 bind.meta 都展开', () => {
    const cols = buildDisplayColumns(top, rows, new Set(['bind', 'bind.meta']));
    expect(cols.map((c) => c.path)).toContain('bind.meta.lvl');
    expect(cols.find((c) => c.path === 'bind.meta.lvl')!.collapseParent).toBe('bind.meta');
  });
});
