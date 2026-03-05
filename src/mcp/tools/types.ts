/**
 * MCP tools 共享的查询结果类型.
 */
export interface QueryResultData {
  readonly columns: ReadonlyArray<{ name: string; dataType: string }>;
  readonly rows: readonly Record<string, unknown>[];
  readonly affectedRows: number;
  readonly executionTime: number;
}
