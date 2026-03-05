/**
 * MCP tool 返回值的公共构造函数.
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

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
