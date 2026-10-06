import { destructiveStatementRanges, type SqlDialect } from '../../../src/utils/destructive-sql';

export interface SqlWarning {
  readonly from: number;
  readonly to: number;
  readonly message: string;
}

// 编辑器划线: 与宿主执行前弹确认的是同一批语句 (DROP / TRUNCATE, ALTER TABLE ... DROP, 无 WHERE 的 DELETE / UPDATE)
export function diagnoseSql(sql: string, dialect: SqlDialect): readonly SqlWarning[] {
  return destructiveStatementRanges(sql, dialect).map(({ start, end }) => ({
    from: start,
    to: end,
    message: 'Destructive statement (DROP / TRUNCATE, ALTER TABLE ... DROP, or DELETE / UPDATE without WHERE)',
  }));
}
