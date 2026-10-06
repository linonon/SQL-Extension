import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage } from '../../../../src/types/messages';
import { DatabaseObjectList, type DatabaseInfo } from './DatabaseObjectList';
import { QueryEditor } from '../query-editor/QueryEditor';
import { ConfirmBar } from '../common/ConfirmBar';
import { buildSelectSql } from '../../utils/sql-builder';
import '../../styles/db-browser.css';

interface DatabaseBrowserProps {
  readonly connectionId: string;
  readonly driverType: string;
  // 连接表单里填的 Database: 列表默认只列它
  readonly defaultDatabase?: string;
}

// 系统库: 默认不列. PG 的模板库宿主已排除, 没有要藏的
const SYSTEM_DATABASES: Readonly<Record<string, ReadonlySet<string>>> = {
  mysql: new Set(['mysql', 'information_schema', 'performance_schema', 'sys']),
};

// 左侧列表显示哪些库: 连接配了 Database 且它在列表里时只列它 (showAll 关闭时); 否则隐藏系统库 (showSystem 关闭时)
export function visibleDatabases(
  databases: readonly DatabaseInfo[],
  driverType: string,
  scope: { readonly defaultDatabase?: string; readonly showAll: boolean; readonly showSystem: boolean },
): readonly DatabaseInfo[] {
  if (!scope.showAll && scope.defaultDatabase) {
    const only = databases.filter((d) => d.name === scope.defaultDatabase);
    if (only.length > 0) return only;
  }
  const system = SYSTEM_DATABASES[driverType];
  return scope.showSystem || !system ? databases : databases.filter((d) => !system.has(d.name.toLowerCase()));
}

interface SelectedTable {
  readonly database: string;
  readonly table: string;
}

export function DatabaseBrowser({ connectionId, driverType, defaultDatabase }: DatabaseBrowserProps) {
  const [databases, setDatabases] = useState<readonly DatabaseInfo[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [selected, setSelected] = useState<SelectedTable | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(220);
  // key 用于强制 QueryEditor 重新 mount
  const [queryKey, setQueryKey] = useState(0);
  // 当前表网格里未保存的编辑数; 切表会重挂载编辑器丢掉它们, 先确认
  const [pendingEdits, setPendingEdits] = useState(0);
  const [switchTo, setSwitchTo] = useState<SelectedTable | null>(null);

  const postMessage = usePostMessage();
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    if (msg.type === 'databaseTableList') {
      setDatabases(msg.databases);
      setLoadError(msg.error ?? null);
      setLoading(false);
    }
    // 笼统失败 (如按需重连失败) 由 App 显示, 这里只结束 loading
    if (msg.type === 'error') {
      setLoading(false);
    }
  }, []);

  useVSCodeMessage(handleMessage);

  // mount 时请求 database + table 列表
  useEffect(() => {
    setLoading(true);
    postMessage({ type: 'listDatabasesAndTables' });
  }, [postMessage]);

  const openTable = useCallback((target: SelectedTable) => {
    setSwitchTo(null);
    setSelected(target);
    setQueryKey((k) => k + 1);
  }, []);

  // 编辑已保存或撤销, 待确认的切表直接作废 (用户再点一次即可)
  const handlePendingEdits = useCallback((count: number) => {
    setPendingEdits(count);
    if (count === 0) setSwitchTo(null);
  }, []);

  const handleSelectTable = useCallback((database: string, table: string) => {
    if (pendingEdits > 0) {
      setSwitchTo({ database, table });
      return;
    }
    openTable({ database, table });
  }, [pendingEdits, openTable]);

  const handleNewQuery = useCallback((database: string) => {
    postMessage({ type: 'newQuery', database });
  }, [postMessage]);

  const handleImportSql = useCallback((database: string) => {
    postMessage({ type: 'importSql', database });
  }, [postMessage]);

  const handleEditTable = useCallback((database: string, table: string) => {
    postMessage({ type: 'editTable', database, table });
  }, [postMessage]);

  const handleShowDDL = useCallback((database: string, table: string) => {
    postMessage({ type: 'showTableDDL', database, table });
  }, [postMessage]);

  const handleDumpStruct = useCallback((database: string, table: string) => {
    postMessage({ type: 'dumpTable', database, table, includeData: false });
  }, [postMessage]);

  const handleDumpStructAndData = useCallback((database: string, table: string) => {
    postMessage({ type: 'dumpTable', database, table, includeData: true });
  }, [postMessage]);

  const handleRefresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    postMessage({ type: 'listDatabasesAndTables' });
  }, [postMessage]);

  // resize handle
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    startX.current = e.clientX;
    startWidth.current = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) { return; }
      const delta = ev.clientX - startX.current;
      setPanelWidth(Math.max(140, Math.min(600, startWidth.current + delta)));
    };

    const onMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  const initialSql = selected ? buildSelectSql(driverType, selected.table, undefined, null) : '';
  const shown = useMemo(
    () => visibleDatabases(databases, driverType, { defaultDatabase, showAll, showSystem }),
    [databases, driverType, defaultDatabase, showAll, showSystem]
  );
  const canScope = !!defaultDatabase && databases.some((d) => d.name === defaultDatabase);

  return (
    <div className="db-browser">
      <div className="db-browser-toolbar">
        <button className="db-refresh-btn" onClick={handleRefresh} title="Refresh">Refresh</button>
        {canScope && (
          <label className="db-scope-toggle" title={`Connection database: ${defaultDatabase}`}>
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show all databases
          </label>
        )}
        {SYSTEM_DATABASES[driverType] && (!canScope || showAll) && (
          <label className="db-scope-toggle">
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
            Show system databases
          </label>
        )}
      </div>
      <div className="db-browser-body">
        <div className="db-left-panel" style={{ width: panelWidth }}>
          {loadError ? (
            <div className="db-load-error">
              <span>{loadError}</span>
              <button onClick={handleRefresh}>Retry</button>
            </div>
          ) : (
            <DatabaseObjectList
              databases={shown}
              selected={selected}
              loading={loading}
              onSelectTable={handleSelectTable}
              onNewQuery={handleNewQuery}
              onImportSql={handleImportSql}
              onEditTable={handleEditTable}
              onShowDDL={handleShowDDL}
              onDumpStruct={handleDumpStruct}
              onDumpStructAndData={handleDumpStructAndData}
            />
          )}
        </div>
        <div className="db-resize-handle" onMouseDown={handleMouseDown} />
        <div className="db-right-panel">
          {switchTo && (
            <ConfirmBar
              message={`${pendingEdits} unsaved edit${pendingEdits > 1 ? 's' : ''} in ${selected?.table ?? ''} will be discarded.`}
              confirmLabel={`Discard and Open ${switchTo.table}`}
              onConfirm={() => openTable(switchTo)}
              onCancel={() => setSwitchTo(null)}
            />
          )}
          {selected ? (
            <QueryEditor
              key={queryKey}
              connectionId={connectionId}
              database={selected.database}
              driverType={driverType}
              initialSql={initialSql}
              autoExecute={true}
              table={selected.table}
              onPendingEditsChange={handlePendingEdits}
            />
          ) : (
            <div className="db-empty">Select a table to browse data</div>
          )}
        </div>
      </div>
    </div>
  );
}
