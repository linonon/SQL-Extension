export interface ColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly isPrimaryKey: boolean;
  readonly defaultValue: string | null;
  readonly extra: string;
  // 查询结果列的来源: 只在列是某张真实表未改名的原始列时存在 (表达式 / 别名列 / 无法判定时缺省),
  // 结果网格据此判定能否写回. schema 在 MySQL 是 database, 在 PG 是 namespace
  readonly source?: { readonly schema: string; readonly table: string };
}

export interface DetailedColumnInfo extends ColumnInfo {
  readonly comment: string;
}

export interface AlterTableChanges {
  readonly addedColumns: readonly AddColumnDef[];
  readonly droppedColumns: readonly string[];
  readonly modifiedColumns: readonly ModifyColumnDef[];
  readonly renamedColumns: readonly { readonly from: string; readonly to: string }[];
}

export interface AddColumnDef {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
  readonly comment: string;
}

export interface ModifyColumnDef {
  readonly name: string;
  readonly dataType?: string;
  readonly nullable?: boolean;
  readonly defaultValue?: string | null;
  readonly comment?: string;
}
