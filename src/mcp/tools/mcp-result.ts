/**
 * MCP tool 返回值的公共构造函数. 扩展侧 routeByDriver 也用它构造 read / execute 的结果, 经 IPC 原样回传.
 */

// 单个 tool 结果的 JSON 字符数上限: 宽表的 500 行, 大 hash 的 HGETALL 等会一次塞满 agent 的上下文
export const RESULT_SIZE_CAP = 200_000;

export function makeResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: capJson(data) }],
  };
}

// 超过 RESULT_SIZE_CAP 时截掉行的尾部并标 truncated: 带 rows 数组的对象保留形状, 补 rowsReturned;
// 顶层数组包成 { items, total }; 其余形状退回截断的 JSON 原文 (partialJson, 取一半: 再次转义后引号与反斜杠翻倍)
function capJson(data: unknown): string {
  const text = JSON.stringify(data);
  if (text === undefined || text.length <= RESULT_SIZE_CAP) { return text; }
  const note = { truncated: true, sizeCapChars: RESULT_SIZE_CAP };
  const obj = data as { rows?: unknown };
  const rows = Array.isArray(data) ? data : Array.isArray(obj?.rows) ? obj.rows as unknown[] : undefined;
  if (!rows) {
    return JSON.stringify({ ...note, partialJson: text.slice(0, RESULT_SIZE_CAP / 2) });
  }
  const wrap = (n: number) => Array.isArray(data)
    ? { ...note, total: rows.length, items: rows.slice(0, n) }
    : { ...obj, ...note, rowsReturned: n, rows: rows.slice(0, n) };
  // 逐行累加 JSON 长度 (数组元素以逗号分隔), 取放得下的最长前缀
  let size = JSON.stringify(wrap(0)).length + String(rows.length).length;
  let n = 0;
  while (n < rows.length) {
    size += (JSON.stringify(rows[n]) ?? 'null').length + 1;
    if (size > RESULT_SIZE_CAP) { break; }
    n++;
  }
  return JSON.stringify(wrap(n));
}

export function makeError(message: string, code: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}

export type ToolResult = ReturnType<typeof makeResult> | ReturnType<typeof makeError>;

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
