import type { AlterTableChanges } from '../types/query.js';

function escId(driverType: string, name: string): string {
  if (driverType === 'mysql') {
    return `\`${name.replace(/`/g, '``')}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function buildDefaultClause(driverType: string, value: string | null): string {
  if (value === null) {
    return 'DEFAULT NULL';
  }
  // 数值不需要引号
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return `DEFAULT ${value}`;
  }
  if (driverType === 'mysql') {
    return `DEFAULT '${value.replace(/'/g, "''")}'`;
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

  // Rename table
  if (changes.renamedTable) {
    const newName = escId(driverType, changes.renamedTable);
    if (driverType === 'mysql') {
      statements.push(`ALTER TABLE ${tbl} RENAME TO ${newName};`);
    } else {
      statements.push(`ALTER TABLE ${tbl} RENAME TO ${newName};`);
    }
  }

  const targetTable = changes.renamedTable ? escId(driverType, changes.renamedTable) : tbl;

  // Add columns
  for (const col of changes.addedColumns) {
    const colName = escId(driverType, col.name);
    const notNull = col.nullable ? '' : ' NOT NULL';
    const def = col.defaultValue !== null ? ` ${buildDefaultClause(driverType, col.defaultValue)}` : '';

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

  // Rename columns
  for (const rename of changes.renamedColumns) {
    const oldName = escId(driverType, rename.from);
    const newName = escId(driverType, rename.to);
    if (driverType === 'mysql') {
      statements.push(`ALTER TABLE ${targetTable} RENAME COLUMN ${oldName} TO ${newName};`);
    } else {
      statements.push(`ALTER TABLE ${targetTable} RENAME COLUMN ${oldName} TO ${newName};`);
    }
  }

  // Modify columns
  for (const mod of changes.modifiedColumns) {
    const colName = escId(driverType, mod.name);

    if (driverType === 'mysql') {
      // MySQL MODIFY COLUMN 需要完整列定义
      const parts: string[] = [];
      if (mod.dataType !== undefined) { parts.push(mod.dataType); }
      if (mod.nullable !== undefined) { parts.push(mod.nullable ? 'NULL' : 'NOT NULL'); }
      if (mod.defaultValue !== undefined) { parts.push(buildDefaultClause(driverType, mod.defaultValue)); }
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
          statements.push(`ALTER TABLE ${targetTable} ALTER COLUMN ${colName} SET ${buildDefaultClause(driverType, mod.defaultValue)};`);
        }
      }
      if (mod.comment !== undefined) {
        statements.push(`COMMENT ON COLUMN ${targetTable}.${colName} IS '${mod.comment.replace(/'/g, "''")}';`);
      }
    }
  }

  return statements;
}
