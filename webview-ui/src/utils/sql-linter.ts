// 破坏性操作检测: 纯函数, 无外部依赖
// 匹配: DELETE FROM ... (无 WHERE) / DROP TABLE ... / TRUNCATE ...

export interface SqlWarning {
  readonly from: number;
  readonly to: number;
  readonly message: string;
}

const DANGEROUS_PATTERNS: readonly { pattern: RegExp; message: string }[] = [
  {
    pattern: /\bDELETE\s+FROM\s+\S+(?:\s*;|\s*$)/gi,
    message: 'DELETE FROM without WHERE clause',
  },
  {
    pattern: /\bDROP\s+TABLE\b/gi,
    message: 'DROP TABLE detected',
  },
  {
    pattern: /\bTRUNCATE\b/gi,
    message: 'TRUNCATE detected',
  },
];

export function diagnoseSql(sql: string): readonly SqlWarning[] {
  const warnings: SqlWarning[] = [];

  for (const { pattern, message } of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      warnings.push({
        from: match.index,
        to: match.index + match[0].length,
        message,
      });
    }
  }

  return warnings;
}
