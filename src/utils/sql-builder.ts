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

// MySQL 用反引号, PG 用双引号 (alter-table-builder 复用同一实现, 避免转义规则两份漂移)
export function escapeIdentifier(driverType: string, name: string): string {
  if (driverType === 'mysql') {
    return `\`${name.replace(/`/g, '``')}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

// PG 列默认值 nextval('<seq>'::regclass) 里的序列名, 返回可直接拼进 SQL 的标识符文本 (保留 "..." 引用与 schema 前缀)
export function pgSequenceOfDefault(columnDefault: unknown): string | undefined {
  const m = /^nextval\('(.+)'::regclass\)$/.exec(String(columnDefault ?? ''));
  return m ? m[1].replace(/''/g, "'") : undefined;
}

// MySQL 用 qualified name (database.table); PG 由 driver 按 database 选该库的 pool 执行, 不需要
function qualifyTable(driverType: string, table: string, database?: string): string {
  if (database && driverType === 'mysql') {
    return `${escapeIdentifier(driverType, database)}.${escapeIdentifier(driverType, table)}`;
  }
  return escapeIdentifier(driverType, table);
}

export function buildInsert(
  driverType: string,
  table: string,
  row: Record<string, unknown>,
  database?: string
): BuiltSQL {
  const ph = getPlaceholder(driverType);
  const keys = Object.keys(row);
  const qualified = qualifyTable(driverType, table, database);
  // 空 row = 所有列由 DB 默认/自增填充, 插入一行全默认值 (而非拼出非法 SQL)
  if (keys.length === 0) {
    if (driverType === 'postgresql') {
      return { sql: `INSERT INTO ${qualified} DEFAULT VALUES`, params: [] };
    }
    return { sql: `INSERT INTO ${qualified} () VALUES ()`, params: [] };
  }
  const columns = keys.map((k) => escapeIdentifier(driverType, k)).join(', ');
  const placeholders = keys.map((_, i) => ph(i + 1)).join(', ');
  return {
    sql: `INSERT INTO ${qualified} (${columns}) VALUES (${placeholders})`,
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
  const ph = getPlaceholder(driverType);
  const changeKeys = Object.keys(changes);
  const pkKeys = Object.keys(primaryKeys);
  if (changeKeys.length === 0) {
    throw new Error('buildUpdate: no changes to apply');
  }
  // 空 WHERE 会改全表; invariant 落在 builder 边界, 任何 caller 漏拦都立即抛错
  if (pkKeys.length === 0) {
    throw new Error('buildUpdate: refusing UPDATE without WHERE (no primary key)');
  }

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
  const ph = getPlaceholder(driverType);
  const keys = Object.keys(primaryKeysList[0]);
  if (keys.length === 0) {
    throw new Error('buildBatchDelete: refusing DELETE without WHERE (no primary key)');
  }
  // 所有条目须同 key 集, 否则 tuple 列与值会错位导致误删其他行.
  // 比较排序后的键集 (与对象键插入顺序无关; 取值始终按 keys 的名字索引, 顺序不影响正确性)
  const sortedKeys = [...keys].sort();
  const sameKeySet = (other: string[]): boolean => {
    if (other.length !== sortedKeys.length) { return false; }
    const otherSorted = [...other].sort();
    return otherSorted.every((k, i) => k === sortedKeys[i]);
  };
  for (const pks of primaryKeysList) {
    if (!sameKeySet(Object.keys(pks))) {
      throw new Error('buildBatchDelete: inconsistent primary key set across rows');
    }
  }

  const params: unknown[] = [];
  let paramIndex = 1;

  let where: string;
  if (keys.length === 1) {
    // 单主键: 直接构造 col IN (?, ?, ...), 不对已格式化字符串反向切片
    const key = keys[0];
    const placeholders = primaryKeysList.map((pks) => {
      params.push(pks[key]);
      return ph(paramIndex++);
    });
    where = `${escapeIdentifier(driverType, key)} IN (${placeholders.join(', ')})`;
  } else {
    const valueTuples = primaryKeysList.map((pks) => {
      const placeholders = keys.map((k) => {
        params.push(pks[k]);
        return ph(paramIndex++);
      });
      return `(${placeholders.join(', ')})`;
    });
    const pkColumns = keys.map((k) => escapeIdentifier(driverType, k)).join(', ');
    where = `(${pkColumns}) IN (${valueTuples.join(', ')})`;
  }

  return {
    sql: `DELETE FROM ${qualifyTable(driverType, table, database)} WHERE ${where}`,
    params,
  };
}
