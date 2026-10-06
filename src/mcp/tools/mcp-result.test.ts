import { describe, it, expect } from 'vitest';
import { makeResult, RESULT_SIZE_CAP } from './mcp-result';

const parse = (r: ReturnType<typeof makeResult>) => JSON.parse(r.content[0].text);

describe('makeResult 按大小截断', () => {
  const row = ['x'.repeat(1000), 1];

  it('未超限原样返回', () => {
    expect(parse(makeResult({ columns: ['a'], rows: [[1]], rowCount: 1 }))).toEqual({ columns: ['a'], rows: [[1]], rowCount: 1 });
  });

  it('带 rows 的结果: 截掉尾部行, 保留其余字段, 标出 truncated / 上限 / 实际返回行数', () => {
    const r = makeResult({ columns: ['s', 'n'], rows: Array.from({ length: 500 }, () => row), rowCount: 500 });
    expect(r.content[0].text.length).toBeLessThanOrEqual(RESULT_SIZE_CAP);
    const out = parse(r);
    expect(out).toMatchObject({ columns: ['s', 'n'], rowCount: 500, truncated: true, sizeCapChars: RESULT_SIZE_CAP });
    expect(out.rows.length).toBe(out.rowsReturned);
    expect(out.rowsReturned).toBeGreaterThan(150);
    expect(out.rowsReturned).toBeLessThan(500);
  });

  it('顶层数组 (SMEMBERS 等) 包成 items + total; 其他形状给截断的 JSON 原文', () => {
    const members = Array.from({ length: 100_000 }, (_, i) => `member:${i}`);
    const arr = makeResult(members);
    expect(arr.content[0].text.length).toBeLessThanOrEqual(RESULT_SIZE_CAP);
    expect(parse(arr)).toMatchObject({ truncated: true, total: 100_000, items: members.slice(0, parse(arr).items.length) });

    const big = makeResult({ columns: '"'.repeat(RESULT_SIZE_CAP), ddl: 'x' });
    expect(big.content[0].text.length).toBeLessThanOrEqual(RESULT_SIZE_CAP + 100);
    expect(parse(big)).toMatchObject({ truncated: true, sizeCapChars: RESULT_SIZE_CAP });
    expect(parse(big).partialJson.startsWith('{"columns":"\\"')).toBe(true);
  });
});
