// 渲染保护: 单页一次性渲染过多文档 (尤其 list 视图的可折叠树) 会卡顿.
// 这里只限制"渲染条数", 不影响取数/计数/字段推断; 超出时由 UI 显式提示 (no silent cap).

export const MAX_RENDER_ROWS = 200;

export function capRows<T>(
  rows: readonly T[],
  max: number = MAX_RENDER_ROWS,
): { readonly rows: readonly T[]; readonly hidden: number } {
  if (rows.length <= max) { return { rows, hidden: 0 }; }
  return { rows: rows.slice(0, max), hidden: rows.length - max };
}
