import { formatDialect, mysql, postgresql } from 'sql-formatter';

// 只引编辑器用到的两种方言: format() 按名字查方言, 会把全部方言打进 bundle
export function formatSql(sql: string, driverType?: string): string {
  return formatDialect(sql, {
    dialect: driverType === 'postgresql' ? postgresql : mysql,
    tabWidth: 2,
    keywordCase: 'upper',
  });
}
