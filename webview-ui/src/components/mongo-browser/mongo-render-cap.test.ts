import { describe, it, expect } from 'vitest';
import { capRows, MAX_RENDER_ROWS } from './mongo-render-cap';

describe('capRows', () => {
  it('不超过上限时原样返回, hidden=0', () => {
    const rows = [1, 2, 3];
    const r = capRows(rows, 10);
    expect(r.rows).toBe(rows);
    expect(r.hidden).toBe(0);
  });

  it('超过上限时截断并报告隐藏数', () => {
    const rows = Array.from({ length: 250 }, (_, i) => i);
    const r = capRows(rows, 200);
    expect(r.rows).toHaveLength(200);
    expect(r.hidden).toBe(50);
  });

  it('默认上限 MAX_RENDER_ROWS', () => {
    const rows = Array.from({ length: MAX_RENDER_ROWS + 5 }, (_, i) => i);
    const r = capRows(rows);
    expect(r.rows).toHaveLength(MAX_RENDER_ROWS);
    expect(r.hidden).toBe(5);
  });
});
