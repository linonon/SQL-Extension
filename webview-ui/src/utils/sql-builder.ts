export interface SortState {
  readonly column: string;
  readonly direction: 'ASC' | 'DESC';
}

// MySQL 用反引号, PG 用双引号
function escapeIdentifier(driverType: string, name: string): string {
  if (driverType === 'mysql') {
    return `\`${name.replace(/`/g, '``')}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

// MySQL 用 qualified name (database.table), PG 连接已绑定 database 不需要
function qualifyTable(driverType: string, table: string, database?: string): string {
  if (database && driverType === 'mysql') {
    return `${escapeIdentifier(driverType, database)}.${escapeIdentifier(driverType, table)}`;
  }
  return escapeIdentifier(driverType, table);
}

export function buildSelectSql(
  driverType: string,
  table: string,
  database: string | undefined,
  sort: SortState | null,
  limit: number = 50
): string {
  if (driverType === 'mongodb') {
    if (sort) {
      const sortDir = sort.direction === 'ASC' ? 1 : -1;
      return `db.${table}.aggregate([{"$sort":{"${sort.column}":${sortDir}}},{"$limit":${limit}}])`;
    }
    return `db.${table}.find({})`;
  }
  const from = qualifyTable(driverType, table, database);
  const orderBy = sort
    ? ` ORDER BY ${escapeIdentifier(driverType, sort.column)} ${sort.direction}`
    : '';
  return `SELECT * FROM ${from}${orderBy} LIMIT ${limit} OFFSET 0`;
}
