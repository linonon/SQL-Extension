export interface ColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly isPrimaryKey: boolean;
  readonly defaultValue: string | null;
  readonly extra: string;
}

export interface DetailedColumnInfo extends ColumnInfo {
  readonly comment: string;
}

export interface AlterTableChanges {
  readonly renamedTable?: string;
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

export interface PageInfo {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}
