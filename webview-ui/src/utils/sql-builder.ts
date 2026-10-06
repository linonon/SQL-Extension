import { escapeIdentifier, qualifyTable } from '../../../src/utils/sql-builder';

export interface SortState {
  readonly column: string;
  readonly direction: 'ASC' | 'DESC';
}

export function buildSelectSql(
  driverType: string,
  table: string,
  database: string | undefined,
  sort: SortState | null,
  limit: number = 50
): string {
  const from = qualifyTable(driverType, table, database);
  const orderBy = sort
    ? ` ORDER BY ${escapeIdentifier(driverType, sort.column)} ${sort.direction}`
    : '';
  return `SELECT * FROM ${from}${orderBy} LIMIT ${limit} OFFSET 0`;
}
