# Sidebar to Webview Browser Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sidebar 变成 flat 连接列表, 点击连接打开 webview tab; 新增 DatabaseBrowser webview 给 MySQL/PG.

**Architecture:** 参照 MongoBrowser 模式, 新建 DatabaseBrowser (左侧 database > table 列表 + filter, 右侧复用 QueryEditor). 改 ConnectionTreeProvider 为 flat list. 统一所有连接类型的打开路由.

**Tech Stack:** TypeScript, React, VS Code Extension API, CSS

**Spec:** `docs/superpowers/specs/2026-03-12-sidebar-to-webview-browser-design.md`

---

## File Structure

**New files:**
- `webview-ui/src/components/db-browser/DatabaseObjectList.tsx` -- 左侧 database > table 列表, filter input, 右键菜单
- `webview-ui/src/components/db-browser/DatabaseBrowser.tsx` -- 主容器, 左右分栏, 消息协调
- `webview-ui/src/styles/db-browser.css` -- 样式 (参照 mongo-browser.css)

**Modified files:**
- `src/types/messages.ts` -- 新增 db-browser 消息类型, ViewType 新增 `'db-browser'`
- `webview-ui/src/types/messages.ts` -- 同上 (webview 侧类型镜像)
- `webview-ui/src/App.tsx` -- 新增 `db-browser` view case
- `src/providers/table-view-provider.ts` -- 新增 `openDbBrowser` 方法 + db-browser 消息 handler
- `src/extension.ts` -- 统一连接点击路由, 删除废弃 command handler
- `src/providers/tree-items.ts` -- 只保留 ConnectionTreeItem, 删除其余
- `src/providers/connection-tree-provider.ts` -- 删除所有展开逻辑
- `package.json` -- 清理 commands 和 menus
- `src/providers/tree-items.test.ts` -- 删除已删类型的测试
- `src/providers/connection-tree-provider.test.ts` -- 更新为 flat list 测试

---

## Chunk 1: Message Types + DatabaseBrowser Components

### Task 1: Add message types for db-browser

**Files:**
- Modify: `src/types/messages.ts:145` (ViewType)
- Modify: `webview-ui/src/types/messages.ts:8` (ViewType)

- [ ] **Step 1: Add `'db-browser'` to ViewType in `src/types/messages.ts`**

```typescript
// src/types/messages.ts:145 - 修改 ViewType
export type ViewType = 'table' | 'query' | 'connection-form' | 'edit-table' | 'redis-browser' | 'kafka-browser' | 'rmq-browser' | 'mongo-browser' | 'mongo-query' | 'db-browser';
```

- [ ] **Step 2: Add new message types to ExtensionMessage in `src/types/messages.ts`**

在 ExtensionMessage union 末尾 (line 73 之后) 添加:

```typescript
  | { type: 'databaseTableList'; databases: readonly { readonly name: string; readonly tables: readonly { readonly name: string; readonly rowCount: number }[] }[]; error?: string };
```

- [ ] **Step 3: Add new message types to WebviewMessage in `src/types/messages.ts`**

在 WebviewMessage union 末尾 (line 143 之后) 添加:

```typescript
  | { type: 'listDatabasesAndTables' }
  | { type: 'refreshDatabases' }
  | { type: 'showTableDDL'; database: string; table: string }
  | { type: 'dumpTable'; database: string; table: string; includeData: boolean }
  | { type: 'importSql'; database: string; table?: string }
  | { type: 'editTable'; database: string; table: string }
  | { type: 'newQuery'; database: string };
```

- [ ] **Step 4: Mirror changes in `webview-ui/src/types/messages.ts`**

同样修改 webview 侧:
- ViewType (line 8) 加 `'db-browser'`
- ExtensionMessage union 末尾加 `databaseTableList`
- WebviewMessage union 末尾加 7 个新消息类型

- [ ] **Step 5: Run type check**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run lint`
Expected: PASS (新类型目前没有被使用, 不影响编译)

- [ ] **Step 6: Commit**

```bash
git add src/types/messages.ts webview-ui/src/types/messages.ts
git commit -m "feat(db-browser): add message types for DatabaseBrowser"
```

---

### Task 2: Create DatabaseObjectList component

**Files:**
- Create: `webview-ui/src/components/db-browser/DatabaseObjectList.tsx`

- [ ] **Step 1: Create DatabaseObjectList component**

参照 `webview-ui/src/components/mongo-browser/MongoCollectionList.tsx` 的结构. 关键差异:
- filter 支持 `db.table` 格式 (用 `.` 分隔)
- 右键菜单: database 头有 New Query / Import SQL, table 项有 Open Table / Edit Table / Show DDL / Dump Struct / Dump Struct and Data / Import SQL
- 复用 `ContextMenu` 组件 (`webview-ui/src/components/common/ContextMenu.tsx`)

```tsx
import { useCallback, useMemo, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu';

export interface DatabaseInfo {
  readonly name: string;
  readonly tables: readonly TableInfo[];
}

export interface TableInfo {
  readonly name: string;
  readonly rowCount: number;
}

interface SelectedTable {
  readonly database: string;
  readonly table: string;
}

interface DatabaseObjectListProps {
  readonly databases: readonly DatabaseInfo[];
  readonly selected: SelectedTable | null;
  readonly loading?: boolean;
  readonly onSelectTable: (database: string, table: string) => void;
  readonly onNewQuery: (database: string) => void;
  readonly onImportSql: (database: string, table?: string) => void;
  readonly onEditTable: (database: string, table: string) => void;
  readonly onShowDDL: (database: string, table: string) => void;
  readonly onDumpStruct: (database: string, table: string) => void;
  readonly onDumpStructAndData: (database: string, table: string) => void;
}

function formatRowCount(n: number): string {
  if (n >= 1000000) { return `${(n / 1000000).toFixed(1)}M`; }
  if (n >= 1000) { return `${(n / 1000).toFixed(1)}k`; }
  return String(n);
}

function filterDatabases(
  databases: readonly DatabaseInfo[],
  filterText: string
): readonly DatabaseInfo[] {
  if (!filterText) { return databases; }
  const dotIdx = filterText.indexOf('.');
  if (dotIdx >= 0) {
    const dbFilter = filterText.slice(0, dotIdx).toLowerCase();
    const tableFilter = filterText.slice(dotIdx + 1).toLowerCase();
    return databases
      .filter((d) => d.name.toLowerCase().includes(dbFilter))
      .map((d) => ({
        ...d,
        tables: d.tables.filter((t) => t.name.toLowerCase().includes(tableFilter)),
      }))
      .filter((d) => d.tables.length > 0);
  }
  const lower = filterText.toLowerCase();
  return databases
    .map((d) => ({
      ...d,
      tables: d.tables.filter((t) => t.name.toLowerCase().includes(lower)),
    }))
    .filter((d) => d.tables.length > 0);
}

export function DatabaseObjectList({
  databases,
  selected,
  loading,
  onSelectTable,
  onNewQuery,
  onImportSql,
  onEditTable,
  onShowDDL,
  onDumpStruct,
  onDumpStructAndData,
}: DatabaseObjectListProps) {
  const [filter, setFilter] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    items: ContextMenuItem[];
    position: { x: number; y: number };
  } | null>(null);

  const filtered = useMemo(() => filterDatabases(databases, filter), [databases, filter]);

  const isSelected = (db: string, table: string) =>
    selected !== null && selected.database === db && selected.table === table;

  const handleDbContextMenu = useCallback((e: React.MouseEvent, database: string) => {
    e.preventDefault();
    setContextMenu({
      items: [
        { label: 'New Query', action: () => onNewQuery(database) },
        { label: 'Import SQL', action: () => onImportSql(database) },
      ],
      position: { x: e.clientX, y: e.clientY },
    });
  }, [onNewQuery, onImportSql]);

  const handleTableContextMenu = useCallback((e: React.MouseEvent, database: string, table: string) => {
    e.preventDefault();
    setContextMenu({
      items: [
        { label: 'Open Table', action: () => onSelectTable(database, table) },
        { label: 'Edit Table', action: () => onEditTable(database, table) },
        { label: 'Show DDL', action: () => onShowDDL(database, table) },
        { label: 'Dump Struct', action: () => onDumpStruct(database, table) },
        { label: 'Dump Struct and Data', action: () => onDumpStructAndData(database, table) },
        { label: 'Import SQL', action: () => onImportSql(database, table) },
      ],
      position: { x: e.clientX, y: e.clientY },
    });
  }, [onSelectTable, onEditTable, onShowDDL, onDumpStruct, onDumpStructAndData, onImportSql]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <div className="db-object-list-panel">
      <div className="db-filter-bar">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables... (db.table)"
        />
      </div>
      <div className="db-object-list">
        {loading ? (
          <div className="db-spinner-wrap">
            <div className="db-spinner" />
            <span>Loading...</span>
          </div>
        ) : (
          <>
            {filtered.map((db) => (
              <div key={db.name} className="db-group">
                <div
                  className="db-group-header"
                  onContextMenu={(e) => handleDbContextMenu(e, db.name)}
                >
                  <span className="db-group-name">{db.name}</span>
                  <span className="db-group-count">{db.tables.length}</span>
                </div>
                {db.tables.map((t) => (
                  <div
                    key={`${db.name}.${t.name}`}
                    className={`db-table-item${isSelected(db.name, t.name) ? ' selected' : ''}`}
                    onClick={() => onSelectTable(db.name, t.name)}
                    onContextMenu={(e) => handleTableContextMenu(e, db.name, t.name)}
                  >
                    <span className="db-table-name">{t.name}</span>
                    <span className="db-table-count">{formatRowCount(t.rowCount)}</span>
                  </div>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="db-empty">No tables found</div>
            )}
          </>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension/webview-ui && npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/components/db-browser/DatabaseObjectList.tsx
git commit -m "feat(db-browser): add DatabaseObjectList component with filter and context menu"
```

---

### Task 3: Create DatabaseBrowser component

**Files:**
- Create: `webview-ui/src/components/db-browser/DatabaseBrowser.tsx`

- [ ] **Step 1: Create DatabaseBrowser component**

参照 `webview-ui/src/components/mongo-browser/MongoBrowser.tsx` 的结构. 左侧 DatabaseObjectList, 右侧复用 QueryEditor.

```tsx
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
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension/webview-ui && npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/components/db-browser/DatabaseBrowser.tsx
git commit -m "feat(db-browser): add DatabaseBrowser component"
```

---

### Task 4: Add db-browser CSS

**Files:**
- Create: `webview-ui/src/styles/db-browser.css`

- [ ] **Step 1: Create db-browser.css**

参照 `webview-ui/src/styles/mongo-browser.css`, 用 `db-` 前缀替换 `mongo-` 前缀. 只保留布局 + 列表 + 空状态 + spinner 部分, 不需要文档详情等 MongoDB 特有样式.

```css
.db-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.db-browser-toolbar {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  flex-shrink: 0;
}

.db-refresh-btn {
  font-size: 12px;
  padding: 2px 8px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: none;
  border-radius: 2px;
  cursor: pointer;
}

.db-refresh-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}

.db-browser-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.db-left-panel {
  min-width: 140px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.db-resize-handle {
  width: 4px;
  cursor: col-resize;
  background-color: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  flex-shrink: 0;
  transition: background-color 0.15s;
}

.db-resize-handle:hover,
.db-resize-handle:active {
  background-color: var(--vscode-focusBorder, #007fd4);
}

.db-right-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Object list */
.db-object-list-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.db-filter-bar {
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  flex-shrink: 0;
}

.db-filter-bar input[type="text"] {
  width: 100%;
  box-sizing: border-box;
}

.db-object-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.db-group {
  margin-bottom: 2px;
}

.db-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
  position: sticky;
  top: 0;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  z-index: 1;
}

.db-group-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-group-count {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.db-table-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 16px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
}

.db-table-item:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.db-table-item.selected {
  background-color: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.db-table-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-table-count {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}

/* Empty state */
.db-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--vscode-descriptionForeground);
  font-size: 14px;
}

/* Spinner */
.db-spinner-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.db-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--vscode-descriptionForeground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: db-spin 0.7s linear infinite;
  opacity: 0.6;
}

@keyframes db-spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension/webview-ui && npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/styles/db-browser.css
git commit -m "style(db-browser): add DatabaseBrowser styles"
```

---

### Task 5: Wire db-browser into App.tsx

**Files:**
- Modify: `webview-ui/src/App.tsx:9` (import), `webview-ui/src/App.tsx:88-93` (switch case)

- [ ] **Step 1: Add import and case**

在 `App.tsx` 的 import 区域 (line 11 附近) 添加:

```typescript
import { DatabaseBrowser } from './components/db-browser/DatabaseBrowser';
```

在 switch 语句中 `case 'mongo-browser'` 之前 (line 88 附近) 添加:

```typescript
    case 'db-browser':
      return (
        <DatabaseBrowser
          connectionId={viewContext.connectionId as string}
          driverType={viewContext.driverType as string}
        />
      );
```

- [ ] **Step 2: Build webview**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension/webview-ui && npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/App.tsx
git commit -m "feat(db-browser): wire DatabaseBrowser into App"
```

---

## Chunk 2: Extension Host Changes

### Task 6: Add openDbBrowser and message handler to TableViewProvider

**Files:**
- Modify: `src/providers/table-view-provider.ts`

- [ ] **Step 1: Add `openDbBrowser` method**

在 `openMongoBrowser` 方法 (line 165) 之后添加:

```typescript
  openDbBrowser(connectionId: string, connectionName: string, driverType: string): void {
    const iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'resources', `${driverType}-connected-light.svg`),
      dark: vscode.Uri.joinPath(this.extensionUri, 'resources', `${driverType}-connected-dark.svg`),
    };
    this.openBrowser(`db-browser:${connectionId}`, `[${driverType.toUpperCase()}]${connectionName}`, 'db-browser', {
      connectionId,
      driverType,
    }, iconPath);
  }
```

- [ ] **Step 2: Add db-browser message handling in `handleMessage`**

在 `handleMessage` 方法的 `default` case 中 (line 472 附近), 在 `if (message.type.startsWith('rmq'))` 之前, 添加 db-browser 消息处理:

```typescript
          // db-browser messages
          if (message.type === 'listDatabasesAndTables' || message.type === 'refreshDatabases') {
            const driver = this.connectionManager.getDriver(connectionId!);
            try {
              const dbNames = await driver.listDatabases();
              const databases = await Promise.all(
                dbNames.map(async (name) => {
                  const tables = await driver.listTables(name);
                  return {
                    name,
                    tables: tables.map((t) => ({ name: t.name, rowCount: t.rowCount })),
                  };
                })
              );
              panel.webview.postMessage({ type: 'databaseTableList', databases });
            } catch (err) {
              panel.webview.postMessage({
                type: 'databaseTableList',
                databases: [],
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return;
          }

          if (message.type === 'showTableDDL') {
            const { database, table } = message as { database: string; table: string };
            this.showTableDDL(connectionId!, database, table);
            return;
          }

          if (message.type === 'dumpTable') {
            const { database, table, includeData } = message as { database: string; table: string; includeData: boolean };
            const driver = this.connectionManager.getDriver(connectionId!);
            const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
            const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const uri = await vscode.window.showSaveDialog({
              filters: { 'SQL Files': ['sql'] },
              defaultUri: vscode.Uri.file(`${baseDir}/${table}_${ts}.sql`),
            });
            if (!uri) { return; }
            if (includeData) {
              const { DumpService } = await import('../services/dump-service.js');
              const dumpService = new DumpService();
              await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Dumping ${table}...`, cancellable: true },
                async (progress, token) => {
                  const content = await dumpService.dumpStructAndData(
                    driver, database, table,
                    (current, total) => { progress.report({ increment: 0, message: `${current}/${total} rows` }); },
                    token
                  );
                  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
                  vscode.window.showInformationMessage(`Data dumped to ${uri.fsPath}`);
                }
              );
            } else {
              const { DumpService } = await import('../services/dump-service.js');
              const dumpService = new DumpService();
              const content = await dumpService.dumpStruct(driver, database, table);
              await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
              vscode.window.showInformationMessage(`Struct dumped to ${uri.fsPath}`);
            }
            return;
          }

          if (message.type === 'importSql') {
            const { database } = message as { database: string; table?: string };
            const uris = await vscode.window.showOpenDialog({
              filters: { 'SQL Files': ['sql'] },
              canSelectMany: false,
            });
            if (!uris || uris.length === 0) { return; }
            const fileContent = await vscode.workspace.fs.readFile(uris[0]);
            const sql = Buffer.from(fileContent).toString('utf-8');
            const driver = this.connectionManager.getDriver(connectionId!);
            try {
              const { promise } = driver.executeCancellable(sql, undefined, database);
              const result = await promise;
              vscode.window.showInformationMessage(`SQL imported. Affected rows: ${result.affectedRows}`);
              // 刷新左侧列表
              const dbNames = await driver.listDatabases();
              const databases = await Promise.all(
                dbNames.map(async (name) => {
                  const tables = await driver.listTables(name);
                  return { name, tables: tables.map((t) => ({ name: t.name, rowCount: t.rowCount })) };
                })
              );
              panel.webview.postMessage({ type: 'databaseTableList', databases });
            } catch (err) {
              vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }

          if (message.type === 'editTable') {
            const { database, table } = message as { database: string; table: string };
            this.openEditTable(connectionId!, database, table);
            return;
          }

          if (message.type === 'newQuery') {
            const { database } = message as { database: string };
            this.openQueryEditor(connectionId!, database);
            return;
          }
```

- [ ] **Step 3: Build extension**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run compile`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/providers/table-view-provider.ts
git commit -m "feat(db-browser): add openDbBrowser method and message handlers"
```

---

### Task 7: Unify connection click routing in extension.ts

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add `openBrowserForConnection` helper function**

先确保文件顶部有 `DriverType` import. 在现有 import 区域添加:

```typescript
import type { DriverType } from './types/connection.js';
```

然后在 `activate` 函数内 (line 39, `dumpService` 之后) 添加:

```typescript
  function openBrowserForConnection(id: string, name: string, dt: DriverType): void {
    switch (dt) {
      case 'mysql':
      case 'postgresql':
        viewProvider.openDbBrowser(id, name, dt);
        break;
      case 'redis':
        viewProvider.openRedisBrowser(id, 0);
        break;
      case 'kafka':
        viewProvider.openKafkaBrowser(id);
        break;
      case 'rabbitmq':
        viewProvider.openRabbitMQBrowser(id);
        break;
      case 'mongodb':
        viewProvider.openMongoBrowser(id, name, dt);
        break;
    }
  }
```

- [ ] **Step 2: Update `sqlext.connect` command handler**

将 line 71-86 的 `sqlext.connect` handler 改为:

```typescript
    ['sqlext.connect', async (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        // 已连接则直接打开 browser, 不重复连接
        const connInfo = connectionManager.getConnectionInfo().find(c => c.config.id === item.connectionId);
        if (connInfo?.state === 'connected') {
          openBrowserForConnection(item.connectionId, item.connectionName, item.driverType);
          return;
        }
        try {
          await connectionManager.connect(item.connectionId);
          vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
        openBrowserForConnection(item.connectionId, item.connectionName, item.driverType);
      }
    }],
```

- [ ] **Step 3: Update `connectionManager.onDidChange` listener**

注意: `sqlext.connect` handler 中已经调用了 `openBrowserForConnection`, 但 `onDidChange` listener 仍然需要保留 -- 它负责捕获非 sidebar 触发的连接 (如 command palette, 自动重连等). `openBrowserForConnection` 内部通过 `viewProvider.openBrowser` 的 panelKey dedup 保证不会重复打开 tab.

将 line 411-421 的 listener 改为:

```typescript
  const previousStates = new Map<string, string>();
  connectionManager.onDidChange(() => {
    for (const info of connectionManager.getConnectionInfo()) {
      const prev = previousStates.get(info.config.id);
      if (prev !== 'connected' && info.state === 'connected') {
        openBrowserForConnection(info.config.id, info.config.name, info.config.driverType);
      }
      previousStates.set(info.config.id, info.state);
    }
  });
```

- [ ] **Step 4: Delete obsolete command handlers**

删除以下 command handler (连同数组项):
- `sqlext.openRedisDb` (line 253-257)
- `sqlext.refreshRedisDb` (line 259-263)
- `sqlext.exportRedisDb` (line 265-298)
- `sqlext.importRedisDb` (line 300-327)
- `sqlext.openRedisKey` (line 231-235)
- `sqlext.deleteRedisKey` (line 237-251)
- `sqlext.openKafkaTopic` (line 329-333)
- `sqlext.openRabbitMQQueue` (line 335-338)
- `sqlext.openMongoBrowser` (line 341-350)
- `sqlext.mongoCreateCollection` (line 352-375)
- `sqlext.mongoDropCollection` (line 377-398)

- [ ] **Step 5: Update remaining command handlers to remove TreeItem instanceof checks**

`sqlext.openTable` (line 101-114): 改为同时支持 ConnectionTreeItem (打开 db-browser) 和 `{ connectionId, database, table }` 对象:

```typescript
    ['sqlext.openTable', (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (args.connectionId && args.database && args.table) {
        viewProvider.openTableView(args.connectionId, args.database, args.table);
      }
    }],
```

`sqlext.newQuery`: 简化为只接受 `{ connectionId, database }`:

```typescript
    ['sqlext.newQuery', (item: unknown) => {
      const args = item as { connectionId?: string; database?: string };
      if (args.connectionId && args.database) {
        const conn = connectionManager.getConnections().find((c) => c.id === args.connectionId);
        if (conn?.driverType === 'mongodb') {
          viewProvider.openMongoQueryEditor(args.connectionId, args.database, conn.name);
        } else {
          viewProvider.openQueryEditor(args.connectionId, args.database);
        }
      }
    }],
```

`sqlext.editTable`, `sqlext.showTableDDL`, `sqlext.dumpStruct`, `sqlext.dumpStructAndData`, `sqlext.importSql`: 类似地改为接受 plain object 参数. 注意 `dumpStruct` 和 `dumpStructAndData` 仍然需要 vscode API (showSaveDialog), 保留现有逻辑但去掉 `instanceof TableTreeItem` 检查:

```typescript
    ['sqlext.editTable', (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (args.connectionId && args.database && args.table) {
        viewProvider.openEditTable(args.connectionId, args.database, args.table);
      }
    }],

    ['sqlext.showTableDDL', (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (args.connectionId && args.database && args.table) {
        viewProvider.showTableDDL(args.connectionId, args.database, args.table);
      }
    }],

    ['sqlext.dumpStruct', async (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (!args.connectionId || !args.database || !args.table) { return; }
      const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const uri = await vscode.window.showSaveDialog({
        filters: { 'SQL Files': ['sql'] },
        defaultUri: vscode.Uri.file(`${baseDir}/${args.table}_${ts}.sql`),
      });
      if (!uri) { return; }
      const driver = connectionManager.getDriver(args.connectionId);
      const content = await dumpService.dumpStruct(driver, args.database, args.table);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
      vscode.window.showInformationMessage(`Struct dumped to ${uri.fsPath}`);
    }],

    ['sqlext.dumpStructAndData', async (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (!args.connectionId || !args.database || !args.table) { return; }
      const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const uri = await vscode.window.showSaveDialog({
        filters: { 'SQL Files': ['sql'] },
        defaultUri: vscode.Uri.file(`${baseDir}/${args.table}_${ts}.sql`),
      });
      if (!uri) { return; }
      const driver = connectionManager.getDriver(args.connectionId);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Dumping ${args.table}...`, cancellable: true },
        async (progress, token) => {
          const content = await dumpService.dumpStructAndData(
            driver, args.database!, args.table!,
            (current, total) => { progress.report({ increment: 0, message: `${current}/${total} rows` }); },
            token
          );
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
          vscode.window.showInformationMessage(`Data dumped to ${uri.fsPath}`);
        }
      );
    }],

    ['sqlext.importSql', async (item: unknown) => {
      const args = item as { connectionId?: string; database?: string };
      if (!args.connectionId || !args.database) { return; }
      const uris = await vscode.window.showOpenDialog({
        filters: { 'SQL Files': ['sql'] },
        canSelectMany: false,
      });
      if (!uris || uris.length === 0) { return; }
      const fileContent = await vscode.workspace.fs.readFile(uris[0]);
      const sql = Buffer.from(fileContent).toString('utf-8');
      const driver = connectionManager.getDriver(args.connectionId);
      try {
        const { promise } = driver.executeCancellable(sql, undefined, args.database);
        const result = await promise;
        vscode.window.showInformationMessage(`SQL imported. Affected rows: ${result.affectedRows}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }],
```

- [ ] **Step 6: Clean up imports**

删除 `extension.ts` 中不再需要的 import:
- `DatabaseTreeItem`, `KafkaTopicTreeItem`, `MongoDatabaseTreeItem`, `MongoCollectionTreeItem`, `RabbitMQQueueTreeItem`, `RedisDbTreeItem`, `RedisKeyTreeItem`, `TableTreeItem` 从 line 9 的 import 中移除
- `MongoDriver` type import (line 10) 移除
- `exportRedisKeys`, `importRedisKeys` from line 12 移除

最终 import 简化为:

```typescript
import { ConnectionTreeItem, setResourcesPath } from './providers/tree-items.js';
```

- [ ] **Step 7: Build extension**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run compile`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -m "refactor(extension): unify connection click routing and remove obsolete commands"
```

---

## Chunk 3: Sidebar Simplification + Cleanup

### Task 8: Simplify tree-items.ts

**Files:**
- Modify: `src/providers/tree-items.ts`

- [ ] **Step 1: Delete all non-Connection TreeItem classes**

保留 `ConnectionTreeItem` (line 11-49), 删除 line 52-228 的所有其他类:
- `DatabaseTreeItem`
- `TableTreeItem`
- `ColumnTreeItem`
- `KafkaTopicTreeItem`
- `RabbitMQQueueTreeItem`
- `MongoDatabaseTreeItem`
- `MongoCollectionTreeItem`
- `RedisDbTreeItem`
- `RedisKeyGroupTreeItem`
- `MoreKeysTreeItem`
- `RedisKeyTreeItem`

- [ ] **Step 2: Modify ConnectionTreeItem collapsibleState**

将 line 20-27 的 constructor 中 `super(...)` 调用改为:

```typescript
    super(connectionName, vscode.TreeItemCollapsibleState.None);
```

删除原来根据 state 区分 Expanded/Collapsed/None 的逻辑.

- [ ] **Step 3: Add click command to open browser**

在 ConnectionTreeItem constructor 末尾 (line 48 之前), 非 connecting 状态时添加 click command:

```typescript
    if (state !== 'connecting') {
      this.command = {
        command: 'sqlext.connect',
        title: 'Connect',
        arguments: [this],
      };
    }
```

这样点击连接就会触发 `sqlext.connect`, 由 Step 7 中修改的 handler 处理 (已连接则直接打开 browser, 未连接则先连接再打开).

- [ ] **Step 4: Build extension**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run compile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/tree-items.ts
git commit -m "refactor(tree-items): keep only ConnectionTreeItem, remove all child tree items"
```

---

### Task 9: Simplify ConnectionTreeProvider

**Files:**
- Modify: `src/providers/connection-tree-provider.ts`

- [ ] **Step 1: Delete all get*Items methods and simplify getChildren**

删除以下方法: `getDatabaseItems`, `getTableItems`, `getColumnItems`, `getRedisDbItems`, `getRedisKeyItems`, `subdivideRedisKeys`, `getKafkaTopicItems`, `getRabbitMQQueueItems`, `getMongoDatabaseItems`, `getMongoCollectionItems`.

简化 `getChildren`:

```typescript
  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    return [];
  }
```

- [ ] **Step 2: Clean up imports**

简化 import (line 4-17), 只保留:

```typescript
import { ConnectionTreeItem } from './tree-items.js';
```

简化 `TreeItem` type alias:

```typescript
type TreeItem = ConnectionTreeItem;
```

删除 `SchemaService` import 和 `schemaService` field.

- [ ] **Step 3: Build extension**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run compile`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/providers/connection-tree-provider.ts
git commit -m "refactor(tree-provider): simplify to flat connection list"
```

---

### Task 10: Clean up package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove obsolete commands from `contributes.commands`**

删除以下 command 定义:
- `sqlext.openRedisKey` (line 112-115)
- `sqlext.deleteRedisKey` (line 117-121)
- `sqlext.refreshRedisDb` (line 123-127)
- `sqlext.openRedisDb` (line 129-132)
- `sqlext.exportRedisDb` (line 140-143)
- `sqlext.importRedisDb` (line 145-148)
- `sqlext.openKafkaTopic` (line 150-153)
- `sqlext.openRabbitMQQueue` (line 155-158)
- `sqlext.openMongoBrowser` (line 160-164)
- `sqlext.mongoCreateCollection` (line 166-169)
- `sqlext.mongoDropCollection` (line 170-173)

- [ ] **Step 2: Clean up `menus.view/item/context`**

删除所有非 `connection-*` 的 viewItem 菜单项. 保留:
- `sqlext.cancelConnect` (viewItem == connection-connecting)
- `sqlext.refreshConnections` (viewItem =~ /^connection-connected/)
- `sqlext.disconnect` (viewItem =~ /^connection-connected/)
- `sqlext.editConnection` (viewItem =~ /^connection/)
- `sqlext.removeConnection` (viewItem =~ /^connection/)

删除:
- `sqlext.openMongoBrowser` (viewItem == connection-connected-mongodb) -- 包括 inline
- `sqlext.newQuery` (viewItem == database 和 viewItem == mongo-database)
- `sqlext.openTable` (viewItem == table, inline)
- `sqlext.editTable` (viewItem == table)
- `sqlext.showTableDDL` (viewItem == table)
- `sqlext.dumpStruct` (viewItem == table)
- `sqlext.dumpStructAndData` (viewItem == table)
- `sqlext.importSql` (viewItem == database 和 viewItem == table)
- `sqlext.refreshRedisDb` (viewItem == redis-db)
- `sqlext.deleteRedisKey` (viewItem == redis-key)
- `sqlext.exportRedisDb` (viewItem == redis-db)
- `sqlext.importRedisDb` (viewItem == redis-db)
- `sqlext.openKafkaTopic` (viewItem == kafka-topic)
- `sqlext.openRabbitMQQueue` (viewItem == rmq-queue)
- `sqlext.mongoCreateCollection` (viewItem == mongo-database)
- `sqlext.mongoDropCollection` (viewItem == mongo-collection)

- [ ] **Step 3: Remove `showCollapseAll` from treeView config**

在 `extension.ts` line 48, `showCollapseAll: true` 可以去掉 (flat list 不需要 collapse all). 这步在 extension.ts 中做, 但逻辑上属于 package.json 清理.

- [ ] **Step 4: Build all**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.ts
git commit -m "chore: clean up obsolete commands and menus from package.json"
```

---

### Task 11: Update tests

**Files:**
- Modify: `src/providers/tree-items.test.ts`
- Modify: `src/providers/connection-tree-provider.test.ts`

- [ ] **Step 1: Rewrite tree-items.test.ts**

删除 `DatabaseTreeItem`, `TableTreeItem`, `ColumnTreeItem`, `RedisDbTreeItem`, `RedisKeyTreeItem`, `RedisKeyGroupTreeItem`, `MoreKeysTreeItem` 的所有测试. 只保留 `ConnectionTreeItem` 的测试, 并更新断言:
- 所有 state 的 `collapsibleState` 改为 `None`
- connected 状态不再是 `Expanded`
- disconnected 状态不再是 `Collapsed`
- 非 connecting 状态有 `command` (指向 `sqlext.connect`)

```typescript
import { describe, it, expect } from 'vitest';
import { ConnectionTreeItem } from './tree-items';
import * as vscode from 'vscode';

describe('tree-items', () => {
  describe('ConnectionTreeItem', () => {
    it('disconnected 状态', () => {
      const item = new ConnectionTreeItem('conn1', 'MySQL Local', 'localhost', 3306, 'mysql', 'disconnected');

      expect(item.label).toBe('MySQL Local');
      expect(item.description).toBe('localhost:3306');
      expect(item.contextValue).toBe('connection-disconnected');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect(item.command?.command).toBe('sqlext.connect');
    });

    it('connected 状态', () => {
      const item = new ConnectionTreeItem('conn1', 'PG Local', '127.0.0.1', 5432, 'postgresql', 'connected');

      expect(item.contextValue).toBe('connection-connected-postgresql');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect(item.command?.command).toBe('sqlext.connect');
    });

    it('connecting 状态', () => {
      const item = new ConnectionTreeItem('conn1', 'MySQL', 'localhost', 3306, 'mysql', 'connecting');

      expect(item.contextValue).toBe('connection-connecting');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect(item.iconPath).toEqual(new vscode.ThemeIcon('loading~spin'));
      expect(item.command?.command).toBe('sqlext.cancelConnect');
    });

    it('should store connection metadata', () => {
      const item = new ConnectionTreeItem('conn-id-123', 'Test', '192.168.1.1', 9999, 'mysql', 'connected');

      expect(item.connectionId).toBe('conn-id-123');
      expect(item.connectionName).toBe('Test');
      expect(item.host).toBe('192.168.1.1');
      expect(item.port).toBe(9999);
      expect(item.driverType).toBe('mysql');
      expect(item.state).toBe('connected');
    });
  });
});
```

- [ ] **Step 2: Rewrite connection-tree-provider.test.ts**

删除所有 Redis 相关测试. 简化为只测 flat list:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionTreeProvider } from './connection-tree-provider';
import { ConnectionTreeItem } from './tree-items';
import type { ConnectionManager } from '../services/connection-manager';

function createMockConnectionManager(): ConnectionManager {
  return {
    onDidChange: vi.fn().mockReturnValue({ dispose: () => {} }),
    getConnectionInfo: vi.fn().mockReturnValue([]),
  } as unknown as ConnectionManager;
}

describe('ConnectionTreeProvider', () => {
  let provider: ConnectionTreeProvider;
  let connMgr: ConnectionManager;

  beforeEach(() => {
    connMgr = createMockConnectionManager();
    provider = new ConnectionTreeProvider(connMgr);
  });

  it('root returns ConnectionTreeItems', async () => {
    (connMgr.getConnectionInfo as any).mockReturnValue([
      { config: { id: 'c1', name: 'MySQL', host: 'localhost', port: 3306, driverType: 'mysql' }, state: 'disconnected' },
      { config: { id: 'c2', name: 'PG', host: 'localhost', port: 5432, driverType: 'postgresql' }, state: 'connected' },
    ]);

    const children = await provider.getChildren();

    expect(children).toHaveLength(2);
    expect(children[0]).toBeInstanceOf(ConnectionTreeItem);
    expect((children[0] as ConnectionTreeItem).connectionName).toBe('MySQL');
    expect((children[1] as ConnectionTreeItem).connectionName).toBe('PG');
  });

  it('connection item returns empty children (flat list)', async () => {
    const connItem = new ConnectionTreeItem('c1', 'MySQL', 'localhost', 3306, 'mysql', 'connected');
    const children = await provider.getChildren(connItem);

    expect(children).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/providers/tree-items.test.ts src/providers/connection-tree-provider.test.ts
git commit -m "test: update tests for flat connection list"
```

---

### Task 12: Update Redis panelKey + final build verification

**Files:**
- Modify: `src/providers/table-view-provider.ts:144`

- [ ] **Step 1: Change Redis panelKey to per-connection (remove db index)**

```typescript
  openRedisBrowser(connectionId: string, database: number): void {
    const config = this.connectionManager.getConnections().find((c) => c.id === connectionId);
    this.openBrowser(`redis-browser:${connectionId}`, `Redis - ${config?.name ?? connectionId}`, 'redis-browser', {
      connectionId,
      database,
      separator: config?.separator ?? ':',
    });
  }
```

- [ ] **Step 2: Full build**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run build`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/providers/table-view-provider.ts
git commit -m "fix(redis): change panelKey to per-connection single tab"
```
