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
  // 执行结束前调用过 cancel(). 被取消的语句可能照常返回而没有 error (MySQL 被 KILL QUERY 的 SLEEP() 返回 1)
  readonly cancelled?: boolean;
}

// MySQL 的 defaultValue 与 generationExpression 是 SQL 原文 (服务端的转义 / 引号已还原), 表达式默认值由 extra 的 DEFAULT_GENERATED 标出
export interface DetailedColumnInfo extends ColumnInfo {
  readonly comment: string;
  // MySQL 字符串列与表默认不同的 COLLATION_NAME; 相同时, 非字符串列与 PG 缺省
  readonly collation?: string;
  // MySQL 生成列的表达式; 非生成列与 PG 缺省
  readonly generationExpression?: string;
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

// 改动后的完整列定义 (原列合并改动): MySQL MODIFY / CHANGE COLUMN 整列重写, 用完整定义; PG 只对 changed 里的属性逐条 ALTER.
// 改名的列属性没改也在 (changed 为空): MySQL 用它写 CHANGE COLUMN
export interface ModifyColumnDef {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
  readonly comment: string;
  // 原列的 information_schema EXTRA (如 auto_increment, DEFAULT_GENERATED on update CURRENT_TIMESTAMP); PG 为空
  readonly extra: string;
  // 原列的 collation (MySQL 字符串列, 与表默认不同时): MODIFY 不写出就回落到表默认
  readonly collation?: string;
  // 原列的生成列表达式 (MySQL)
  readonly generationExpression?: string;
  readonly changed: readonly ('dataType' | 'nullable' | 'defaultValue' | 'comment')[];
}
