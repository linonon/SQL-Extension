import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import { formatSql } from '../../utils/format-sql';
import { diagnoseSql } from '../../utils/sql-linter';
import { buildSelectSql } from '../../utils/sql-builder';
import type { SortState } from '../../utils/sql-builder';
import { SqlEditor } from '../sql-editor/SqlEditor';
import { QueryHistory, useQueryHistory } from './QueryHistory';
import { QueryResultsGrid } from './QueryResultsGrid';
import type { ColumnInfo } from '../../types/database';
import type { ExtensionMessage } from '../../types/messages';
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

export function QueryEditor({ database, driverType, initialSql, autoExecute, table }: QueryEditorProps) {
  const [sqlText, setSqlText] = useState(initialSql ?? '');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [fullColumns, setFullColumns] = useState<ColumnInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const postMessage = usePostMessage();
  const { entries: historyEntries, addEntry: addHistoryEntry } = useQueryHistory();
  const lastSqlRef = useRef<string>('');
  const inputRef = useRef<HTMLDivElement>(null);
  const [inputHeight, setInputHeight] = useState<number | undefined>(undefined);
  const resizingRef = useRef(false);

  const handleMessage = useCallback((message: ExtensionMessage) => {
    if (message.type === 'queryResult') {
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
        // 重新执行原始 SQL 刷新数据
        if (lastSqlRef.current) {
          setExecuting(true);
          setResult(null);
          postMessage({ type: 'executeQuery', database, sql: lastSqlRef.current });
        }
      }
      if (message.error) {
        setResult((prev) => prev ? { ...prev, error: message.error } : null);
      }
    }
  }, [database, postMessage]);

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
      postMessage({ type: 'listColumns', database, table });
    }
  }, [table, database, postMessage]);

  // mount 时自动执行一次 (Table 点击场景)
  useEffect(() => {
    if (autoExecute && initialSql) {
      setExecuting(true);
      setResult(null);
      lastSqlRef.current = initialSql;
      postMessage({ type: 'executeQuery', database, sql: initialSql });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const executeQuery = useCallback(() => {
    const trimmed = sqlText.trim();
    if (!trimmed) return;
    setExecuting(true);
    setResult(null);
    lastSqlRef.current = trimmed;
    postMessage({ type: 'executeQuery', database, sql: trimmed });
  }, [sqlText, database, postMessage]);

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

  // 仅当 openTableView 场景且表有 PK 时可编辑
  const hasPK = fullColumns.some((c) => c.isPrimaryKey);
  const editable = !!table && hasPK;

  const handleBatchSave = useCallback(
    (updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]) => {
      if (!table || updates.length === 0) return;
      setSaving(true);
      postMessage({ type: 'batchUpdate', database, table, updates });
    },
    [database, table, postMessage]
  );

  const handleInsertRow = useCallback(
    (row: Record<string, unknown>) => {
      if (!table) return;
      postMessage({ type: 'insertRow', database, table, row });
      setTimeout(() => {
        const sql = buildSelectSql(driverType ?? '', table, undefined, sortState);
        postMessage({ type: 'executeQuery', database, sql });
      }, 200);
    },
    [table, database, driverType, postMessage, sortState]
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
      setExecuting(true);
      setResult(null);
      lastSqlRef.current = newSql;
      postMessage({ type: 'executeQuery', database, sql: newSql });
    },
    [table, driverType, database, sortState, postMessage]
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
        />
        <div className="query-editor-toolbar">
          {executing ? (
            <button onClick={cancelQuery}>Cancel</button>
          ) : (
            <button onClick={executeQuery} disabled={!sqlText.trim()}>
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
          <span className="hint">Ctrl+Enter to execute</span>
        </div>
      </div>
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
      {result && (
        <QueryResultsGrid
          columns={displayColumns}
          rows={result.rows}
          affectedRows={result.affectedRows}
          executionTime={result.executionTime}
          error={result.error}
          editable={editable}
          saving={saving}
          onSave={handleBatchSave}
          sortState={table ? sortState : undefined}
          onSort={table ? handleSort : undefined}
          onExportCsv={handleExportCsv}
          onInsertRow={editable ? handleInsertRow : undefined}
        />
      )}
    </div>
  );
}
