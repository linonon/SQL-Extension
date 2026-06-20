// 列自适应宽度的字符数上限: 避免超长文本字段 (text/json/url) 把列撑得过宽
export const MAX_FIT_CHARS = 128;

// 从全量行数据选出该列用于测宽的代表字符串.
// 关键: 用 rows 数据而非已渲染的 DOM 单元格 —— 网格是虚拟滚动, 测宽时 tbody 里只有 (甚至没有)
// 可见行, 读 DOM 会漏掉未渲染行的内容, 导致列宽塌成表头宽度. rows 是完整结果集, 恒在内存.
// 取显示字符串字符数最长的一行, 截断到 maxChars (即列宽上限). NULL/undefined 按 'NULL' 文本计.
export function widestCellSample(
  rows: readonly Record<string, unknown>[],
  colName: string,
  maxChars: number = MAX_FIT_CHARS,
): string {
  let widest = '';
  for (const row of rows) {
    const v = row[colName];
    const s = v === null || v === undefined ? 'NULL' : String(v);
    const capped = s.length > maxChars ? s.slice(0, maxChars) : s;
    if (capped.length > widest.length) {
      widest = capped;
    }
  }
  return widest;
}
