import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import { formatSql } from '../../utils/format-sql';
import { diagnoseSql } from '../../utils/sql-linter';
import { buildSelectSql } from '../../utils/sql-builder';
import { statementAtCaret } from '../../../../src/utils/destructive-sql';
import type { SortState } from '../../utils/sql-builder';
import { SqlEditor } from '../sql-editor/SqlEditor';
import { QueryHistory, useQueryHistory } from './QueryHistory';
import { QueryResultsGrid } from './QueryResultsGrid';
import { StatementSummaryList } from './StatementSummaryList';
import { AiAskBar } from './AiAskBar';
import type { ColumnInfo } from '../../types/database';
import type { ExtensionMessage, StatementResult } from '../../types/messages';
import '../../styles/query-editor.css';
import '../../styles/data-grid.css';

interface QueryEditorProps {
  readonly connectionId: string;
  readonly database: string;
  readonly driverType?: string;
  readonly initialSql?: string;
  readonly autoExecute?: boolean;
  readonly table?: string;
}

interface ResultState {
  readonly columns: ColumnInfo[];
  readonly rows: Record<string, unknown>[];
  readonly affectedRows: number;
  readonly executionTime: number;
  readonly error?: string;
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

export function QueryEditor({ database, driverType, initialSql, autoExecute, table }: QueryEditorProps) {
  const [sqlText, setSqlText] = useState(initialSql ?? '');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [fullColumns, setFullColumns] = useState<ColumnInfo[]>([]);
  const [saving, setSaving] = useState(false);
  // 保存(批量更新/插入)失败的错误: 单独存, 不并入 result.error, 以免覆盖整个结果表丢失数据+未保存编辑
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [selectionStart, setSelectionStart] = useState(0);
  const [batchStatements, setBatchStatements] = useState<StatementResult[] | null>(null);
  // 执行结束时会话随连接销毁带来的提示 (如未提交的事务已被回滚)
  const [batchWarning, setBatchWarning] = useState<string | null>(null);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [showAsk, setShowAsk] = useState(false);
  const postMessage = usePostMessage();
  const { entries: historyEntries, addEntry: addHistoryEntry } = useQueryHistory();
  const lastSqlRef = useRef<string>('');
  // 最近一次 executeQuery / listColumns 的 requestId, 回执对不上即是过期回包, 丢弃
  const queryIdRef = useRef(0);
  const columnsIdRef = useRef(0);
  // 发 Save / Insert 时网格结果所属的 query requestId: 成功回执到达时若已有新查询替换了网格, 不重跑 lastSql
  // (lastSql 此时是用户新跑的语句, 可能是 UPDATE, 重跑即重复写)
  const saveQueryIdRef = useRef(0);
  const inputRef = useRef<HTMLDivElement>(null);
  const [inputHeight, setInputHeight] = useState<number | undefined>(undefined);
  const resizingRef = useRef(false);

  const sendQuery = useCallback((sql: string) => {
    queryIdRef.current = ++requestSeq;
    lastSqlRef.current = sql;
    setExecuting(true);
    setResult(null);
    setBatchWarning(null);
    postMessage({ type: 'executeQuery', requestId: queryIdRef.current, database, sql });
  }, [database, postMessage]);

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
      });
      setExecuting(false);
    }
    if (message.type === 'schemaInfo') {
      setSchema(message.schema);
    }
    if (message.type === 'columnsResult') {
      setFullColumns(message.columns);
    }
    if (message.type === 'batchUpdateResult') {
      setSaving(false);
      if (message.success) {
        setSaveError(null);
        // 重新执行原始 SQL 刷新数据
        if (lastSqlRef.current && queryIdRef.current === saveQueryIdRef.current) {
          sendQuery(lastSqlRef.current);
        }
      }
      if (message.error) {
        // 行内提示, 保留结果表与未保存编辑, 用户可就地改正重存, 无需重跑 query
        setSaveError(message.error);
      }
    }
    if (message.type === 'insertRowResult') {
      if (message.success) {
        setSaveError(null);
        if (lastSqlRef.current && queryIdRef.current === saveQueryIdRef.current) {
          sendQuery(lastSqlRef.current);
        }
      }
      if (message.error) {
        setSaveError(message.error);
      }
    }
  }, [sendQuery]);

  useVSCodeMessage(handleMessage);

  // 查询成功后存入历史
  useEffect(() => {
    if (result && !result.error && lastSqlRef.current) {
      addHistoryEntry(lastSqlRef.current, result.executionTime);
    }
  }, [result, addHistoryEntry]);

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
    // 宿主只在 MySQL 上按 ; 切分; 别的库含 dollar quote 或 \' 时客户端切不准 (函数体 / 以反斜杠结尾的字符串), 整段执行
    if (caret === undefined || (driverType !== 'mysql' && /\$\w*\$|\\'/.test(sqlText))) return sqlText.trim();
    return statementAtCaret(sqlText, caret) ?? '';
  }, [selectedText, selectionStart, sqlText, driverType]);

  const executeQuery = useCallback((caret?: number) => {
    // 执行中再按 Ctrl+Enter 不发新请求: 前一条会失去回执和 Cancel, 成为孤儿查询
    if (executing) return;
    const trimmed = resolveSql(caret);
    if (!trimmed) return;
    setSaveError(null);
    setBatchStatements(null);
    sendQuery(trimmed);
  }, [executing, resolveSql, sendQuery]);

  const cancelQuery = useCallback(() => {
    postMessage({ type: 'cancelQuery' });
  }, [postMessage]);

  const warnings = useMemo(() => diagnoseSql(sqlText), [sqlText]);

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

  // 仅 db-browser 点表 (有 table) 且表结构已到达时判定; PG 的 db-browser 只列 public schema 的表
  const lockReason = table && fullColumns.length > 0 && result
    ? readOnlyReason(result.columns, fullColumns, driverType === 'postgresql' ? 'public' : database, table)
    : undefined;
  const editable = lockReason === null;
  // Insert / Clone 显式写 panel 表, 不依赖结果来源, 只要求表有主键
  const canInsert = !!table && fullColumns.some((c) => c.isPrimaryKey);

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

  const handleSort = useCallback(
    (columnId: string) => {
      if (!table || !driverType) return;
      const next: SortState | null =
        sortState?.column !== columnId
          ? { column: columnId, direction: 'ASC' }
          : sortState.direction === 'ASC'
            ? { column: columnId, direction: 'DESC' }
            : null;
      setSortState(next);
      const newSql = buildSelectSql(driverType, table, undefined, next);
      setSqlText(newSql);
      sendQuery(newSql);
    },
    [table, driverType, sortState, sendQuery]
  );

  // 合并 fullColumns 的元信息到 result.columns
  const displayColumns = useMemo(() => {
    if (!result || result.columns.length === 0) return [];
    if (fullColumns.length === 0) return result.columns;
    return result.columns.map((rc) => {
      const full = fullColumns.find((fc) => fc.name === rc.name);
      return full ?? rc;
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
          <button onClick={() => setShowAsk(true)} title="Ask Copilot about this query">
            Ask AI
          </button>
          <span className="db-badge" title={`Current database: ${database}`}>{database}</span>
          <span className="hint">Ctrl+Enter to execute the statement at cursor</span>
        </div>
      </div>
      {showAsk && (
        <AiAskBar
          database={database}
          sql={sqlText}
          selection={selectedText}
          selectionStart={selectionStart}
          onApply={setSqlText}
          onClose={() => setShowAsk(false)}
        />
      )}
      <div className="query-editor-resizer" onMouseDown={handleResizerMouseDown} />
      {showHistory && (
        <div className="query-history-panel">
          <QueryHistory entries={historyEntries} onSelect={handleHistorySelect} />
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
          rows={result.rows}
          affectedRows={result.affectedRows}
          executionTime={result.executionTime}
          error={result.error}
          saveError={saveError ?? undefined}
          onDismissSaveError={() => setSaveError(null)}
          editable={editable}
          readOnlyReason={lockReason ?? undefined}
          saving={saving}
          onSave={handleBatchSave}
          sortState={table ? sortState : undefined}
          onSort={table ? handleSort : undefined}
          onExportCsv={handleExportCsv}
          onInsertRow={canInsert ? handleInsertRow : undefined}
        />
      )}
    </div>
  );
}
