import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import { useReadOnly } from '../../hooks/useReadOnly';
import { formatSql } from '../../utils/format-sql';
import { diagnoseSql } from '../../utils/sql-linter';
import { buildSelectSql } from '../../utils/sql-builder';
import { sortLoadedRows } from '../../utils/sort-rows';
import { statementAtCaret } from '../../../../src/utils/destructive-sql';
import type { SortState } from '../../utils/sql-builder';
import { SqlEditor } from '../sql-editor/SqlEditor';
import { QueryHistory } from './QueryHistory';
import { QueryResultsGrid } from './QueryResultsGrid';
import { StatementSummaryList } from './StatementSummaryList';
import { AiAskBar } from './AiAskBar';
import { ConfirmBar } from '../common/ConfirmBar';
import type { ColumnInfo } from '../../../../src/types/query';
import type { ExtensionMessage, StatementResult } from '../../../../src/types/messages';
import '../../styles/query-editor.css';
import '../../styles/data-grid.css';

interface QueryEditorProps {
  readonly connectionId: string;
  // 独立 Query panel 传入, badge 显示 "连接 / 库" 区分不同环境的同名库; db-browser 内嵌时标题已带连接名, 不传
  readonly connectionName?: string;
  readonly database: string;
  readonly driverType?: string;
  readonly initialSql?: string;
  readonly autoExecute?: boolean;
  readonly table?: string;
  // 网格未保存编辑数变化时通知 (db-browser 切表前确认用)
  readonly onPendingEditsChange?: (count: number) => void;
}

interface ResultState {
  readonly columns: ColumnInfo[];
  readonly rows: Record<string, unknown>[];
  readonly affectedRows: number;
  readonly executionTime: number;
  readonly error?: string;
  // 产出这个结果集的那一条语句 (批里的写语句不在内), 保存 / 插入后只重跑它刷新
  readonly sql?: string;
  // 宿主只发前 RESULT_ROW_CAP 行: truncated 时 rowCount 是语句返回的总行数
  readonly rowCount?: number;
  readonly truncated?: boolean;
}

function lastResultSetFromBatch(statements: readonly StatementResult[]): ResultState | null {
  for (let i = statements.length - 1; i >= 0; i--) {
    const s = statements[i];
    if (s.status === 'ok' && (s.columns?.length ?? 0) > 0) {
      return {
        columns: s.columns ?? [],
        rows: s.rows ?? [],
        affectedRows: s.affectedRows ?? 0,
        executionTime: s.executionTime ?? 0,
        sql: s.sql,
        rowCount: s.rowCount,
        truncated: s.truncated,
      };
    }
  }
  const lastOk = [...statements].reverse().find((s) => s.status === 'ok');
  if (lastOk) {
    return {
      columns: [],
      rows: [],
      affectedRows: lastOk.affectedRows ?? 0,
      executionTime: lastOk.executionTime ?? 0,
    };
  }
  const err = statements.find((s) => s.status === 'error');
  if (err) {
    return { columns: [], rows: [], affectedRows: 0, executionTime: 0, error: err.error };
  }
  return null;
}

// db-browser 结果网格写回的是 panel 表, 所以只在结果确实就是这张表的行时可编辑:
// 每列都是 schema.table 的原始同名列, 且表的全部主键列都在结果里 (否则 UPDATE 的 WHERE 拼不全).
// 返回只读原因, null 表示可编辑
// ponytail: 自连接 (同表多别名) 只有 MySQL driver 能按别名识别并去掉 source; PG RowDescription 不带别名,
// 自连接结果仍判为可编辑, 改非主键所在别名的列会写到主键那一行. 要堵住需解析 SQL 的 FROM 子句
export function readOnlyReason(
  resultColumns: readonly ColumnInfo[],
  tableColumns: readonly ColumnInfo[],
  schema: string,
  table: string,
): string | null {
  const pkColumns = tableColumns.filter((c) => c.isPrimaryKey);
  if (pkColumns.length === 0) return `Read-only: ${table} has no primary key`;
  if (!resultColumns.every((c) => c.source?.schema === schema && c.source.table === table)) {
    return `Read-only: result is not a plain selection from ${table}`;
  }
  if (!pkColumns.every((pk) => resultColumns.some((c) => c.name === pk.name))) {
    return `Read-only: primary key of ${table} is not in the result`;
  }
  return null;
}

// 请求序号在整个 webview 内递增: db-browser 切表会重挂载编辑器, 旧实例的请求不能与新实例的撞号
let requestSeq = 0;

export function QueryEditor({ connectionName, database, driverType, initialSql, autoExecute, table, onPendingEditsChange }: QueryEditorProps) {
  const readOnly = useReadOnly();
  const dbLabel = (connectionName ? `${connectionName} / ${database}` : database) + (readOnly ? ' (read-only)' : '');
  const [sqlText, setSqlText] = useState(initialSql ?? '');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [fullColumns, setFullColumns] = useState<ColumnInfo[]>([]);
  // 取表结构 (listColumns) 失败的错误: 网格据此说明为什么只读
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 保存(批量更新/插入)失败的错误: 单独存, 不并入 result.error, 以免覆盖整个结果表丢失数据+未保存编辑
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [selectionStart, setSelectionStart] = useState(0);
  const [batchStatements, setBatchStatements] = useState<StatementResult[] | null>(null);
  // 执行结束时会话随连接销毁带来的提示 (如未提交的事务已被回滚)
  const [batchWarning, setBatchWarning] = useState<string | null>(null);
  const [sortState, setSortState] = useState<SortState | null>(null);
  // true: sortState 只作用于内存里已加载的行 (编辑器不是默认浏览 SQL, 不能改写成 ORDER BY)
  const [clientSort, setClientSort] = useState(false);
  const [showAsk, setShowAsk] = useState(false);
  const [pendingEdits, setPendingEdits] = useState(0);
  // 有未保存编辑时用户要执行的 SQL, 等确认丢弃
  const [discardPrompt, setDiscardPrompt] = useState<string | null>(null);
  const postMessage = usePostMessage();
  const lastSqlRef = useRef<string>('');
  // 最近一次 executeQuery / listColumns 的 requestId, 回执对不上即是过期回包, 丢弃
  const queryIdRef = useRef(0);
  const columnsIdRef = useRef(0);
  // 发 Save / Insert / Delete 时网格结果所属的 query requestId, 供 refreshAfterWrite 判断网格是否已被新查询替换
  const saveQueryIdRef = useRef(0);
  const inputRef = useRef<HTMLDivElement>(null);
  const [inputHeight, setInputHeight] = useState<number | undefined>(undefined);
  const resizingRef = useRef(false);

  const sendQuery = useCallback((sql: string) => {
    queryIdRef.current = ++requestSeq;
    lastSqlRef.current = sql;
    setExecuting(true);
    setResult(null);
    setPendingEdits(0);
    setBatchWarning(null);
    postMessage({ type: 'executeQuery', requestId: queryIdRef.current, database, sql });
  }, [database, postMessage]);

  useEffect(() => {
    onPendingEditsChange?.(pendingEdits);
    // 编辑已保存或撤销时撤掉待确认的执行
    if (pendingEdits === 0) setDiscardPrompt(null);
  }, [pendingEdits, onPendingEditsChange]);

  // Save / Insert / Delete 成功后刷新网格: 只重跑产出网格的那条语句; 网格已被新查询替换时不重跑 (那是用户新跑的语句, 可能是写)
  const resultSqlRef = useRef<string | undefined>(undefined);
  resultSqlRef.current = result?.sql;
  const refreshAfterWrite = useCallback(() => {
    if (resultSqlRef.current && queryIdRef.current === saveQueryIdRef.current) {
      sendQuery(resultSqlRef.current);
    }
  }, [sendQuery]);

  const handleMessage = useCallback((message: ExtensionMessage) => {
    if ((message.type === 'queryBatchResult' || message.type === 'queryResult') && message.requestId !== queryIdRef.current) return;
    if (message.type === 'columnsResult' && message.requestId !== columnsIdRef.current) return;
    if (message.type === 'queryBatchResult') {
      setBatchStatements(message.statements);
      setBatchWarning(message.warning ?? null);
      const derived = lastResultSetFromBatch(message.statements);
      setResult(derived);
      setExecuting(false);
    }
    if (message.type === 'queryResult') {
      setBatchStatements(null);
      setResult({
        columns: message.columns,
        rows: message.rows,
        affectedRows: message.affectedRows,
        executionTime: message.executionTime,
        error: message.error,
        sql: lastSqlRef.current,
      });
      setExecuting(false);
    }
    if (message.type === 'schemaInfo') {
      setSchema(message.schema);
    }
    if (message.type === 'columnsResult') {
      setFullColumns(message.columns);
      setColumnsError(message.error ?? null);
    }
    if (message.type === 'batchUpdateResult') {
      setSaving(false);
      if (message.success) {
        setSaveError(null);
        refreshAfterWrite();
      }
      if (message.error) {
        // 行内提示, 保留结果表与未保存编辑, 用户可就地改正重存, 无需重跑 query
        setSaveError(message.error);
      }
    }
    if (message.type === 'insertRowResult' || message.type === 'deleteRowsResult') {
      if (message.success) {
        setSaveError(null);
        refreshAfterWrite();
      }
      if (message.error) {
        setSaveError(message.error);
      }
    }
    // 笼统失败 (如按需重连失败) 由 App 显示, 这里只结束执行 / 保存中的状态
    if (message.type === 'error') {
      setExecuting(false);
      setSaving(false);
    }
  }, [refreshAfterWrite]);

  useVSCodeMessage(handleMessage);

  // mount 时请求 schema 信息
  useEffect(() => {
    postMessage({ type: 'requestSchema', database });
  }, [database, postMessage]);

  // mount 时: 有 table 就请求完整列信息
  useEffect(() => {
    if (table) {
      columnsIdRef.current = ++requestSeq;
      postMessage({ type: 'listColumns', requestId: columnsIdRef.current, database, table });
    }
  }, [table, database, postMessage]);

  // db-browser 切表会卸载编辑器: 卸载时还在执行的查询已无人接收回执, 让宿主取消它, 不在库上空跑
  const executingRef = useRef(false);
  executingRef.current = executing;
  useEffect(() => () => {
    if (executingRef.current) postMessage({ type: 'cancelQuery' });
  }, [postMessage]);

  // mount 时自动执行一次 (Table 点击场景)
  useEffect(() => {
    if (autoExecute && initialSql) {
      sendQuery(initialSql);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 有选区执行选区; 没有选区时快捷键 (带 caret) 只执行光标所在的那条语句, Execute 按钮执行整段
  const resolveSql = useCallback((caret?: number) => {
    // 格式化 / 历史 / AI 套用等程序改写内容时不触发选区事件, 记下的选区可能已过期: 原位置对不上就当没有选区
    const trimmedSelection = selectedText.trim();
    if (trimmedSelection && sqlText.startsWith(selectedText, selectionStart)) return trimmedSelection;
    if (caret === undefined) return sqlText.trim();
    return statementAtCaret(sqlText, caret, driverType === 'postgresql' ? 'postgresql' : 'mysql') ?? '';
  }, [selectedText, selectionStart, sqlText, driverType]);

  const isBrowseSql = useCallback(
    (sql: string, sort: SortState | null) => !!table && !!driverType && sql.trim() === buildSelectSql(driverType, table, undefined, sort),
    [table, driverType]
  );

  const runUserQuery = useCallback((sql: string) => {
    setSaveError(null);
    setBatchStatements(null);
    // 排序标记跟着新结果走: 执行的正是当前排序的默认浏览 SQL 才保留, 内存排序一律作废
    if (!isBrowseSql(sql, sortState)) setSortState(null);
    setClientSort(false);
    sendQuery(sql);
  }, [isBrowseSql, sortState, sendQuery]);

  const executeQuery = useCallback((caret?: number) => {
    // 执行中再按 Ctrl+Enter 不发新请求: 前一条会失去回执和 Cancel, 成为孤儿查询
    if (executing) return;
    const trimmed = resolveSql(caret);
    if (!trimmed) return;
    // 新结果会替换网格, 未保存的编辑先确认丢弃
    if (pendingEdits > 0) {
      setDiscardPrompt(trimmed);
      return;
    }
    runUserQuery(trimmed);
  }, [executing, resolveSql, pendingEdits, runUserQuery]);

  const cancelQuery = useCallback(() => {
    postMessage({ type: 'cancelQuery' });
  }, [postMessage]);

  const warnings = useMemo(() => diagnoseSql(sqlText, driverType === 'postgresql' ? 'postgresql' : 'mysql'), [sqlText, driverType]);

  const handleFormat = useCallback(() => {
    setSqlText(formatSql(sqlText, driverType));
  }, [sqlText, driverType]);

  const refreshSchema = useCallback(() => {
    postMessage({ type: 'refreshSchema', database });
  }, [database, postMessage]);

  const handleHistorySelect = useCallback((sql: string) => {
    setSqlText(sql);
    setShowHistory(false);
  }, []);

  const toggleHistory = useCallback(() => {
    setShowHistory((prev) => !prev);
  }, []);

  // 仅 db-browser 点表 (有 table) 时判定: 只读连接一律只读, 否则等表结构到达按结果来源判定; PG 的 db-browser 只列 public schema 的表
  const lockReason = table && result && readOnly
    ? 'Read-only: connection is read-only'
    : table && result && columnsError
      ? `Read-only: could not load the structure of ${table}: ${columnsError}`
      : table && fullColumns.length > 0 && result
        ? readOnlyReason(result.columns, fullColumns, driverType === 'postgresql' ? 'public' : database, table)
        : undefined;
  const editable = lockReason === null;
  // Insert / Clone 显式写 panel 表, 不依赖结果来源, 只要求表有主键
  const canInsert = !readOnly && !!table && fullColumns.some((c) => c.isPrimaryKey);

  const handleBatchSave = useCallback(
    (updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]) => {
      if (!table || updates.length === 0) return;
      setSaving(true);
      setSaveError(null);
      saveQueryIdRef.current = queryIdRef.current;
      postMessage({ type: 'batchUpdate', database, table, updates });
    },
    [database, table, postMessage]
  );

  const handleInsertRow = useCallback(
    (row: Record<string, unknown>) => {
      if (!table) return;
      setSaveError(null);
      saveQueryIdRef.current = queryIdRef.current;
      postMessage({ type: 'insertRow', database, table, row });
    },
    [table, database, postMessage]
  );

  // 宿主先弹确认框, 取消时回执 cancelled, 不刷新也不报错
  const handleDeleteRows = useCallback(
    (primaryKeys: Record<string, unknown>[]) => {
      if (!table || primaryKeys.length === 0) return;
      setSaveError(null);
      saveQueryIdRef.current = queryIdRef.current;
      postMessage({ type: 'deleteRows', database, table, primaryKeys });
    },
    [table, database, postMessage]
  );

  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = inputRef.current?.offsetHeight ?? 200;
    const maxH = window.innerHeight * 0.6;
    resizingRef.current = true;
    const resizer = e.currentTarget as HTMLElement;
    resizer.classList.add('active');

    const onMouseMove = (ev: MouseEvent) => {
      const newHeight = Math.min(Math.max(startHeight + ev.clientY - startY, 120), maxH);
      setInputHeight(newHeight);
    };

    const onMouseUp = () => {
      resizingRef.current = false;
      resizer.classList.remove('active');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleExportCsv = useCallback(
    (content: string, defaultFileName: string) => {
      postMessage({ type: 'exportCsv', content, defaultFileName });
    },
    [postMessage]
  );

  // 编辑器里还是 panel 表的默认浏览 SQL 时改写 ORDER BY 交给服务端排;
  // 否则 (用户写了 WHERE 等) 不动编辑器, 只在内存里排已加载的行
  const handleSort = useCallback(
    (columnId: string) => {
      const next: SortState | null =
        sortState?.column !== columnId
          ? { column: columnId, direction: 'ASC' }
          : sortState.direction === 'ASC'
            ? { column: columnId, direction: 'DESC' }
            : null;
      setSortState(next);
      const serverSort = isBrowseSql(sqlText, sortState);
      setClientSort(!serverSort && next !== null);
      if (serverSort && table && driverType) {
        const newSql = buildSelectSql(driverType, table, undefined, next);
        setSqlText(newSql);
        sendQuery(newSql);
      }
    },
    [isBrowseSql, table, driverType, sortState, sqlText, sendQuery]
  );

  const gridNote = [
    result?.truncated ? `Showing first ${result.rows.length} of ${result.rowCount} rows` : '',
    clientSort && sortState ? 'Sorted loaded rows only' : '',
  ].filter(Boolean).join('; ') || undefined;

  // 上一次执行失败时的报错 (批里出错的那条, 或整次执行的错误), 交给 Ask AI
  const lastError = batchStatements?.find((s) => s.status === 'error')?.error ?? result?.error;

  const gridRows = useMemo(
    () => (result && clientSort && sortState ? sortLoadedRows(result.rows, sortState) : result?.rows ?? []),
    [result, clientSort, sortState]
  );

  // 合并 fullColumns 的元信息到 result.columns; source 保留结果列自己的 (Copy as INSERT 按它找来源表)
  const displayColumns = useMemo(() => {
    if (!result || result.columns.length === 0) return [];
    if (fullColumns.length === 0) return result.columns;
    return result.columns.map((rc) => {
      const full = fullColumns.find((fc) => fc.name === rc.name);
      return full ? { ...full, source: rc.source } : rc;
    });
  }, [result, fullColumns]);

  return (
    <div className="query-editor-container">
      <div className="query-editor-input" ref={inputRef} style={inputHeight !== undefined ? { height: inputHeight } : undefined}>
        <SqlEditor
          value={sqlText}
          onChange={setSqlText}
          schema={schema}
          placeholder="SELECT * FROM ..."
          warnings={warnings}
          onExecute={executeQuery}
          onFormat={handleFormat}
          onSelectionChange={(text, start) => { setSelectedText(text); setSelectionStart(start); }}
        />
        <div className="query-editor-toolbar">
          {executing ? (
            <button onClick={cancelQuery}>Cancel</button>
          ) : (
            <button onClick={() => executeQuery()} disabled={!sqlText.trim()} title="Execute the selection, or all statements">
              Execute
            </button>
          )}
          <button onClick={handleFormat} disabled={!sqlText.trim()}>
            Format
          </button>
          <button onClick={toggleHistory}>
            History
          </button>
          <button onClick={refreshSchema} title="Refresh schema for autocomplete">
            Refresh Schema
          </button>
          <button onClick={() => setShowAsk(true)} title="Ask AI about this query">
            Ask AI
          </button>
          <span className="db-badge" title={`Current database: ${dbLabel}`}>{dbLabel}</span>
          <span className="hint">Ctrl+Enter to execute the statement at cursor</span>
        </div>
      </div>
      {showAsk && (
        <AiAskBar
          database={database}
          sql={sqlText}
          selection={selectedText}
          selectionStart={selectionStart}
          lastError={lastError}
          onApply={setSqlText}
          onClose={() => setShowAsk(false)}
        />
      )}
      <div className="query-editor-resizer" onMouseDown={handleResizerMouseDown} />
      {discardPrompt !== null && (
        <ConfirmBar
          message={`${pendingEdits} unsaved edit${pendingEdits > 1 ? 's' : ''} in the grid will be discarded.`}
          confirmLabel="Discard and Execute"
          onConfirm={() => { setDiscardPrompt(null); runUserQuery(discardPrompt); }}
          onCancel={() => setDiscardPrompt(null)}
        />
      )}
      {showHistory && (
        <div className="query-history-panel">
          <QueryHistory onSelect={handleHistorySelect} />
        </div>
      )}
      {executing && !result && (
        <div className="query-loading">
          <div className="query-loading-spinner" />
        </div>
      )}
      {batchWarning && <div className="query-batch-warning">{batchWarning}</div>}
      {batchStatements && batchStatements.length > 1 && (
        <StatementSummaryList statements={batchStatements} />
      )}
      {result && (
        <QueryResultsGrid
          columns={displayColumns}
          rows={gridRows}
          affectedRows={result.affectedRows}
          executionTime={result.executionTime}
          error={result.error}
          saveError={saveError ?? undefined}
          onDismissSaveError={() => setSaveError(null)}
          editable={editable}
          readOnlyReason={lockReason ?? undefined}
          saving={saving}
          onSave={handleBatchSave}
          sortState={sortState}
          onSort={handleSort}
          note={gridNote}
          truncated={result.truncated}
          onExportCsv={handleExportCsv}
          onInsertRow={canInsert ? handleInsertRow : undefined}
          onDeleteRows={editable ? handleDeleteRows : undefined}
          driverType={driverType}
          // 只有结果确定是 panel 表的行 (可编辑) 才指定表名, 否则由网格按结果列来源判断
          table={editable ? table : undefined}
          tableColumns={fullColumns}
          onPendingCountChange={setPendingEdits}
        />
      )}
    </div>
  );
}
