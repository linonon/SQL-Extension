import type { AlterTableChanges } from '../types/query.js';
import { escapeIdentifier } from './sql-builder.js';

// 复用 sql-builder 的标识符转义, 避免反引号/双引号规则两份实现漂移
const escId = escapeIdentifier;

// 无参表达式关键字: 作为 DEFAULT 时不能加引号, 否则退化成字面字符串
const EXPRESSION_DEFAULT_KEYWORDS = new Set([
  'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME',
  'LOCALTIME', 'LOCALTIMESTAMP', 'NULL', 'TRUE', 'FALSE',
]);

// 默认值是 SQL 表达式 (关键字或函数调用) 而非字面字符串
function isExpressionDefault(value: string): boolean {
  const v = value.trim();
  if (EXPRESSION_DEFAULT_KEYWORDS.has(v.toUpperCase())) {
    return true;
  }
  // 函数调用形态: ident(...) 如 now(), CURRENT_TIMESTAMP(6), gen_random_uuid(), nextval('s')
  return /^[A-Za-z_][A-Za-z0-9_]*\s*\(.*\)$/.test(v);
}

function buildDefaultClause(value: string | null): string {
  if (value === null) {
    return 'DEFAULT NULL';
  }
  // 数值与表达式默认值不加引号; 其余按字面字符串加引号转义
  if (/^-?\d+(\.\d+)?$/.test(value) || isExpressionDefault(value)) {
    return `DEFAULT ${value}`;
  }
  return `DEFAULT '${value.replace(/'/g, "''")}'`;
}

export function buildAlterTableStatements(
  driverType: string,
  table: string,
  changes: AlterTableChanges
): readonly string[] {
  const tbl = escId(driverType, table);
  const statements: string[] = [];

  // Rename table (MySQL 与 PG 语法一致)
  if (changes.renamedTable) {
    const newName = escId(driverType, changes.renamedTable);
    statements.push(`ALTER TABLE ${tbl} RENAME TO ${newName};`);
  }

  const targetTable = changes.renamedTable ? escId(driverType, changes.renamedTable) : tbl;

  // Add columns
  for (const col of changes.addedColumns) {
    const colName = escId(driverType, col.name);
    const notNull = col.nullable ? '' : ' NOT NULL';
    const def = col.defaultValue !== null ? ` ${buildDefaultClause(col.defaultValue)}` : '';

    if (driverType === 'mysql') {
      const comment = col.comment ? ` COMMENT '${col.comment.replace(/'/g, "''")}'` : '';
      statements.push(`ALTER TABLE ${targetTable} ADD COLUMN ${colName} ${col.dataType}${notNull}${def}${comment};`);
    } else {
      statements.push(`ALTER TABLE ${targetTable} ADD COLUMN ${colName} ${col.dataType}${notNull}${def};`);
      if (col.comment) {
        statements.push(`COMMENT ON COLUMN ${targetTable}.${colName} IS '${col.comment.replace(/'/g, "''")}';`);
      }
    }
  }

  // Drop columns
  for (const colName of changes.droppedColumns) {
    statements.push(`ALTER TABLE ${targetTable} DROP COLUMN ${escId(driverType, colName)};`);
  }

  // Rename columns (MySQL 8+ 与 PG 语法一致)
  for (const rename of changes.renamedColumns) {
    const oldName = escId(driverType, rename.from);
    const newName = escId(driverType, rename.to);
    statements.push(`ALTER TABLE ${targetTable} RENAME COLUMN ${oldName} TO ${newName};`);
  }

  // Modify columns
  for (const mod of changes.modifiedColumns) {
    const colName = escId(driverType, mod.name);

    if (driverType === 'mysql') {
      // MySQL MODIFY COLUMN 需要完整列定义
      const parts: string[] = [];
      if (mod.dataType !== undefined) { parts.push(mod.dataType); }
      if (mod.nullable !== undefined) { parts.push(mod.nullable ? 'NULL' : 'NOT NULL'); }
      if (mod.defaultValue !== undefined) { parts.push(buildDefaultClause(mod.defaultValue)); }
      if (mod.comment !== undefined) { parts.push(`COMMENT '${mod.comment.replace(/'/g, "''")}'`); }
      if (parts.length > 0) {
        statements.push(`ALTER TABLE ${targetTable} MODIFY COLUMN ${colName} ${parts.join(' ')};`);
      }
    } else {
      // PG 每个属性单独 ALTER
      if (mod.dataType !== undefined) {
        statements.push(`ALTER TABLE ${targetTable} ALTER COLUMN ${colName} TYPE ${mod.dataType};`);
      }
      if (mod.nullable !== undefined) {
        statements.push(
          mod.nullable
            ? `ALTER TABLE ${targetTable} ALTER COLUMN ${colName} DROP NOT NULL;`
            : `ALTER TABLE ${targetTable} ALTER COLUMN ${colName} SET NOT NULL;`
        );
      }
      if (mod.defaultValue !== undefined) {
        if (mod.defaultValue === null) {
          statements.push(`ALTER TABLE ${targetTable} ALTER COLUMN ${colName} DROP DEFAULT;`);
        } else {
          statements.push(`ALTER TABLE ${targetTable} ALTER COLUMN ${colName} SET ${buildDefaultClause(mod.defaultValue)};`);
        }
      }
      if (mod.comment !== undefined) {
        statements.push(`COMMENT ON COLUMN ${targetTable}.${colName} IS '${mod.comment.replace(/'/g, "''")}';`);
      }
    }
  }

  return statements;
}
