import { useCallback, useEffect, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage } from '../../types/messages';
import { DatabaseObjectList, type DatabaseInfo } from './DatabaseObjectList';
import { QueryEditor } from '../query-editor/QueryEditor';
import { buildSelectSql } from '../../utils/sql-builder';
import '../../styles/db-browser.css';

interface DatabaseBrowserProps {
  readonly connectionId: string;
  readonly driverType: string;
}

interface SelectedTable {
  readonly database: string;
  readonly table: string;
}

export function DatabaseBrowser({ connectionId, driverType }: DatabaseBrowserProps) {
  const [databases, setDatabases] = useState<readonly DatabaseInfo[]>([]);
  const [selected, setSelected] = useState<SelectedTable | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelWidth, setPanelWidth] = useState(220);
  // key 用于强制 QueryEditor 重新 mount
  const [queryKey, setQueryKey] = useState(0);

  const postMessage = usePostMessage();
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    if (msg.type === 'databaseTableList') {
      setDatabases(msg.databases);
      setLoading(false);
    }
  }, []);

  useVSCodeMessage(handleMessage);

  // mount 时请求 database + table 列表
  useEffect(() => {
    setLoading(true);
    postMessage({ type: 'listDatabasesAndTables' });
  }, [postMessage]);

  const handleSelectTable = useCallback((database: string, table: string) => {
    setSelected({ database, table });
    setQueryKey((k) => k + 1);
  }, []);

  const handleNewQuery = useCallback((database: string) => {
    postMessage({ type: 'newQuery', database });
  }, [postMessage]);

  const handleImportSql = useCallback((database: string, table?: string) => {
    postMessage({ type: 'importSql', database, table });
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

  return (
    <div className="db-browser">
      <div className="db-browser-toolbar">
        <button className="db-refresh-btn" onClick={handleRefresh} title="Refresh">Refresh</button>
      </div>
      <div className="db-browser-body">
        <div className="db-left-panel" style={{ width: panelWidth }}>
          <DatabaseObjectList
            databases={databases}
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
        </div>
        <div className="db-resize-handle" onMouseDown={handleMouseDown} />
        <div className="db-right-panel">
          {selected ? (
            <QueryEditor
              key={queryKey}
              connectionId={connectionId}
              database={selected.database}
              driverType={driverType}
              initialSql={initialSql}
              autoExecute={true}
              table={selected.table}
            />
          ) : (
            <div className="db-empty">Select a table to browse data</div>
          )}
        </div>
      </div>
    </div>
  );
}
