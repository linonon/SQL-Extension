import type { AlterTableChanges, ModifyColumnDef } from '../types/query.js';
import { escapeIdentifier } from './sql-builder.js';

// 复用 sql-builder 的标识符转义, 避免反引号/双引号规则两份实现漂移
const escId = escapeIdentifier;

// 无参表达式关键字: 作为 DEFAULT 时不能加引号, 否则退化成字面字符串
const EXPRESSION_DEFAULT_KEYWORDS = new Set([
  'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME',
  'LOCALTIME', 'LOCALTIMESTAMP', 'NULL', 'TRUE', 'FALSE',
]);

// MySQL 可以不加括号写的表达式默认值; 其余表达式默认值 (8.0.13+) 必须写成 DEFAULT (expr)
const MYSQL_BARE_EXPRESSION_DEFAULT = /^(CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP)\s*(\(\d*\))?$/i;

// 默认值是 SQL 表达式 (关键字或函数调用) 而非字面字符串
function isExpressionDefault(value: string): boolean {
  const v = value.trim();
  if (EXPRESSION_DEFAULT_KEYWORDS.has(v.toUpperCase())) {
    return true;
  }
  // 函数调用形态: ident(...) 如 now(), CURRENT_TIMESTAMP(6), gen_random_uuid(), nextval('s')
  return /^[A-Za-z_][A-Za-z0-9_]*\s*\(.*\)$/.test(v);
}

// 字符串字面量: MySQL (默认 sql_mode) 的反斜杠是转义符, 要双写; PG (standard_conforming_strings) 只双写单引号
function quoteLiteral(driverType: string, value: string): string {
  const escaped = driverType === 'mysql' ? value.replace(/\\/g, '\\\\') : value;
  return `'${escaped.replace(/'/g, "''")}'`;
}

function buildDefaultClause(driverType: string, value: string): string {
  // 数值, 位串 / 十六进制字面量 (b'01', x'ff') 与表达式默认值不加引号; 其余按字面字符串加引号转义.
  // 带前导零的 (字符串列的 '007') 加引号: 裸写成数值会变成 '7'
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) || /^[bx]'[0-9a-f]*'$/i.test(value) || isExpressionDefault(value)) {
    return `DEFAULT ${value}`;
  }
  return `DEFAULT ${quoteLiteral(driverType, value)}`;
}

// 带字符集的字符串类型; 类型里自带 CHARACTER SET / COLLATE 时以类型为准
const MYSQL_STRING_TYPE = /^\s*(?:(?:var)?char|(?:tiny|medium|long)?text|enum|set)\b/i;
const MYSQL_CHARSET_CLAUSE = /\b(?:collate|character\s+set|charset)\b/i;

// MySQL MODIFY COLUMN 的完整列定义: 类型, COLLATE, NULL / NOT NULL, DEFAULT, EXTRA 里的列属性 (auto_increment, on update ...), COMMENT.
// 原列的 collation 在新类型仍是字符串类型时写回, 不写就回落到表默认 (COLLATE 已隐含字符集).
// 未改动的默认值若是表达式 (EXTRA 带 DEFAULT_GENERATED) 按表达式写回: information_schema 里表达式中的引号是 \' 转义形式,
// 先还原; DEFAULT_GENERATED 本身只是元信息, 不写
function mysqlColumnDefinition(mod: ModifyColumnDef): string {
  const parts = [mod.dataType];
  if (mod.collation && MYSQL_STRING_TYPE.test(mod.dataType) && !MYSQL_CHARSET_CLAUSE.test(mod.dataType)) {
    parts.push(`COLLATE ${mod.collation}`);
  }
  parts.push(mod.nullable ? 'NULL' : 'NOT NULL');
  if (mod.defaultValue !== null) {
    const generated = /\bDEFAULT_GENERATED\b/i.test(mod.extra) && !mod.changed.includes('defaultValue');
    parts.push(generated && !MYSQL_BARE_EXPRESSION_DEFAULT.test(mod.defaultValue)
      ? `DEFAULT (${mod.defaultValue.replace(/\\'/g, "'")})`
      : buildDefaultClause('mysql', mod.defaultValue));
  }
  const extra = mod.extra.replace(/\bDEFAULT_GENERATED\b/gi, '').trim();
  if (extra) { parts.push(extra); }
  if (mod.comment) { parts.push(`COMMENT ${quoteLiteral('mysql', mod.comment)}`); }
  return parts.join(' ');
}

export function buildAlterTableStatements(
  driverType: string,
  table: string,
  changes: AlterTableChanges
): readonly string[] {
  const tbl = escId(driverType, table);
  const statements: string[] = [];

  // Add columns
  for (const col of changes.addedColumns) {
    const colName = escId(driverType, col.name);
    const notNull = col.nullable ? '' : ' NOT NULL';
    const def = col.defaultValue !== null ? ` ${buildDefaultClause(driverType, col.defaultValue)}` : '';

    if (driverType === 'mysql') {
      const comment = col.comment ? ` COMMENT ${quoteLiteral(driverType, col.comment)}` : '';
      statements.push(`ALTER TABLE ${tbl} ADD COLUMN ${colName} ${col.dataType}${notNull}${def}${comment};`);
    } else {
      statements.push(`ALTER TABLE ${tbl} ADD COLUMN ${colName} ${col.dataType}${notNull}${def};`);
      if (col.comment) {
        statements.push(`COMMENT ON COLUMN ${tbl}.${colName} IS ${quoteLiteral(driverType, col.comment)};`);
      }
    }
  }

  // Drop columns
  for (const colName of changes.droppedColumns) {
    statements.push(`ALTER TABLE ${tbl} DROP COLUMN ${escId(driverType, colName)};`);
  }

  // Rename columns (MySQL 8+ 与 PG 语法一致)
  for (const rename of changes.renamedColumns) {
    const oldName = escId(driverType, rename.from);
    const newName = escId(driverType, rename.to);
    statements.push(`ALTER TABLE ${tbl} RENAME COLUMN ${oldName} TO ${newName};`);
  }

  // Modify columns
  for (const mod of changes.modifiedColumns) {
    if (mod.changed.length === 0) { continue; }
    const colName = escId(driverType, mod.name);

    if (driverType === 'mysql') {
      // MODIFY COLUMN 整列重写: 没写出的属性 (NOT NULL / DEFAULT / AUTO_INCREMENT / COMMENT) 都会丢, 所以总是写完整定义
      statements.push(`ALTER TABLE ${tbl} MODIFY COLUMN ${colName} ${mysqlColumnDefinition(mod)};`);
    } else {
      // PG 每个改动的属性单独 ALTER, 未改动的属性不受影响
      if (mod.changed.includes('dataType')) {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${colName} TYPE ${mod.dataType};`);
      }
      if (mod.changed.includes('nullable')) {
        statements.push(
          mod.nullable
            ? `ALTER TABLE ${tbl} ALTER COLUMN ${colName} DROP NOT NULL;`
            : `ALTER TABLE ${tbl} ALTER COLUMN ${colName} SET NOT NULL;`
        );
      }
      if (mod.changed.includes('defaultValue')) {
        if (mod.defaultValue === null) {
          statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${colName} DROP DEFAULT;`);
        } else {
          statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${colName} SET ${buildDefaultClause(driverType, mod.defaultValue)};`);
        }
      }
      if (mod.changed.includes('comment')) {
        statements.push(`COMMENT ON COLUMN ${tbl}.${colName} IS ${quoteLiteral(driverType, mod.comment)};`);
      }
    }
  }

  return statements;
}
