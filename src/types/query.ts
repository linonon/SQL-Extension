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

// 一个库的一列 (自动补全与 Ask AI 用). type: MySQL 是带长度的 COLUMN_TYPE, PG 是 data_type
export interface SchemaColumn {
  readonly table: string;
  readonly name: string;
  readonly type: string;
  readonly comment: string;
}

export interface TableInfo {
  readonly name: string;
  readonly schema: string;
  readonly rowCount: number;
}

// 行按列名建对象. 同名列 (JOIN 的 u.id / o.id) 已去重: 再次出现的改成 `<表别名>.<列名>`
// (PG 没有别名信息, 用 `<列名> (2)`), columns[i].name 就是行对象的 key
export interface QueryResult {
  readonly columns: readonly ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  readonly affectedRows: number;
  readonly executionTime: number;
}

// executeBatch 里一条成功语句的结果. sql 是对应的语句原文; PG 一段文本产出多条结果而无法对应原文时为命令标签 (如 INSERT)
export interface StatementOutcome extends QueryResult {
  readonly sql: string;
}

// 一次 executeBatch 的结果: results 按序是成功语句的结果; error.index 是失败的那条输入语句, 其后的输入语句未执行
export interface BatchOutcome {
  readonly results: readonly StatementOutcome[];
  readonly error?: { readonly index: number; readonly cause: unknown };
  // 批内显式开启的事务到结束仍未提交 / 回滚: 会话随连接销毁, 服务端已回滚
  readonly warning?: string;
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
