export interface BuiltSQL {
  readonly sql: string;
  readonly params: unknown[];
}

// 参数化占位符生成器
type PlaceholderFn = (index: number) => string;

const mysqlPlaceholder: PlaceholderFn = () => '?';
const pgPlaceholder: PlaceholderFn = (i) => `$${i}`;

function getPlaceholder(driverType: string): PlaceholderFn {
  return driverType === 'postgresql' ? pgPlaceholder : mysqlPlaceholder;
}

// MongoDB collection name 校验: 仅允许合法标识符
function validateMongoCollection(name: string): string {
  if (!/^[a-zA-Z_$][\w$]*$/.test(name)) {
    throw new Error(`Invalid MongoDB collection name: "${name}"`);
  }
  return name;
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

// 生成人类可读 SQL, 用于预填到 QueryEditor 给用户编辑
export function buildDefaultSelectSql(
  driverType: string,
  table: string,
  database?: string,
  limit: number = 50
): string {
  if (driverType === 'mongodb') {
    return `db.${validateMongoCollection(table)}.find({})`;
  }
  return `SELECT * FROM ${qualifyTable(driverType, table, database)} LIMIT ${limit} OFFSET 0`;
}

export function buildSelect(
  driverType: string,
  table: string,
  offset: number,
  limit: number,
  database?: string
): BuiltSQL {
  if (driverType === 'mongodb') {
    return {
      sql: `db.${validateMongoCollection(table)}.aggregate([{"$skip":${offset}},{"$limit":${limit}}])`,
      params: [],
    };
  }
  const ph = getPlaceholder(driverType);
  return {
    sql: `SELECT * FROM ${qualifyTable(driverType, table, database)} LIMIT ${ph(1)} OFFSET ${ph(2)}`,
    params: [limit, offset],
  };
}

export function buildCount(driverType: string, table: string, database?: string): BuiltSQL {
  if (driverType === 'mongodb') {
    return { sql: `db.${validateMongoCollection(table)}.countDocuments({})`, params: [] };
  }
  return {
    sql: `SELECT COUNT(*) as count FROM ${qualifyTable(driverType, table, database)}`,
    params: [],
  };
}

export function buildInsert(
  driverType: string,
  table: string,
  row: Record<string, unknown>,
  database?: string
): BuiltSQL {
  if (driverType === 'mongodb') {
    return { sql: `db.${validateMongoCollection(table)}.insertOne(${JSON.stringify(row)})`, params: [] };
  }
  const ph = getPlaceholder(driverType);
  const keys = Object.keys(row);
  const columns = keys.map((k) => escapeIdentifier(driverType, k)).join(', ');
  const placeholders = keys.map((_, i) => ph(i + 1)).join(', ');
  return {
    sql: `INSERT INTO ${qualifyTable(driverType, table, database)} (${columns}) VALUES (${placeholders})`,
    params: keys.map((k) => row[k]),
  };
}

export function buildUpdate(
  driverType: string,
  table: string,
  primaryKeys: Record<string, unknown>,
  changes: Record<string, unknown>,
  database?: string
): BuiltSQL {
  if (driverType === 'mongodb') {
    return {
      sql: `db.${validateMongoCollection(table)}.updateOne(${JSON.stringify(primaryKeys)},{"$set":${JSON.stringify(changes)}})`,
      params: [],
    };
  }
  const ph = getPlaceholder(driverType);
  const changeKeys = Object.keys(changes);
  const pkKeys = Object.keys(primaryKeys);

  let paramIndex = 1;
  const setClauses = changeKeys.map((k) => {
    const clause = `${escapeIdentifier(driverType, k)} = ${ph(paramIndex)}`;
    paramIndex++;
    return clause;
  });
  const whereClauses = pkKeys.map((k) => {
    const clause = `${escapeIdentifier(driverType, k)} = ${ph(paramIndex)}`;
    paramIndex++;
    return clause;
  });

  return {
    sql: `UPDATE ${qualifyTable(driverType, table, database)} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
    params: [...changeKeys.map((k) => changes[k]), ...pkKeys.map((k) => primaryKeys[k])],
  };
}

export function buildDelete(
  driverType: string,
  table: string,
  primaryKeys: Record<string, unknown>,
  database?: string
): BuiltSQL {
  if (driverType === 'mongodb') {
    return { sql: `db.${validateMongoCollection(table)}.deleteOne(${JSON.stringify(primaryKeys)})`, params: [] };
  }
  const ph = getPlaceholder(driverType);
  const keys = Object.keys(primaryKeys);
  const whereClauses = keys.map((k, i) => `${escapeIdentifier(driverType, k)} = ${ph(i + 1)}`);
  return {
    sql: `DELETE FROM ${qualifyTable(driverType, table, database)} WHERE ${whereClauses.join(' AND ')}`,
    params: keys.map((k) => primaryKeys[k]),
  };
}

// 批量删除: DELETE FROM t WHERE (pk1, pk2) IN ((v1, v2), (v3, v4), ...)
export function buildBatchDelete(
  driverType: string,
  table: string,
  primaryKeysList: readonly Record<string, unknown>[],
  database?: string
): BuiltSQL {
  if (primaryKeysList.length === 0) {
    return { sql: '', params: [] };
  }
  if (driverType === 'mongodb') {
    const filters = primaryKeysList.map((pks) => JSON.stringify(pks));
    return {
      sql: `db.${validateMongoCollection(table)}.deleteMany({"$or":[${filters.join(',')}]})`,
      params: [],
    };
  }
  const ph = getPlaceholder(driverType);
  const keys = Object.keys(primaryKeysList[0]);
  const params: unknown[] = [];
  let paramIndex = 1;

  const valueTuples = primaryKeysList.map((pks) => {
    const placeholders = keys.map((k) => {
      params.push(pks[k]);
      return ph(paramIndex++);
    });
    return `(${placeholders.join(', ')})`;
  });

  const pkColumns = keys.map((k) => escapeIdentifier(driverType, k)).join(', ');
  const where = keys.length === 1
    ? `${escapeIdentifier(driverType, keys[0])} IN (${valueTuples.map((t) => t.slice(1, -1)).join(', ')})`
    : `(${pkColumns}) IN (${valueTuples.join(', ')})`;

  return {
    sql: `DELETE FROM ${qualifyTable(driverType, table, database)} WHERE ${where}`,
    params,
  };
}
