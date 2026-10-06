import { format } from 'sql-formatter';

const dialectMap: Record<string, 'mysql' | 'postgresql'> = {
  mysql: 'mysql',
  postgresql: 'postgresql',
};

export function formatSql(sql: string, driverType?: string): string {
  return format(sql, {
    language: dialectMap[driverType ?? ''] ?? 'sql',
    tabWidth: 2,
    keywordCase: 'upper',
  });
}
