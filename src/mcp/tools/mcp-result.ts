/**
 * MCP tool 返回值的公共构造函数. 扩展侧 routeByDriver 也用它构造 read / execute 的结果, 经 IPC 原样回传.
 */
export function makeResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
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
