# Clone Row as New Record - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** MySQL 查询结果表格右键行 -> 弹出表单 -> 编辑预填数据 -> 插入新记录.

**Architecture:** 在 QueryResultsGrid 右键菜单加 "Clone as New Row" 项, 弹出 CloneRowModal 组件 (webview 内 Modal), 用户编辑后通过现有 `insertRow` 消息发送到 extension host 执行 INSERT. 需要给 QueryResultsGrid 新增 `onInsertRow` 回调, 由 QueryEditor 提供实现.

**Tech Stack:** React, TypeScript, VS Code Webview API, 现有 ContextMenu 组件

---

### Task 1: CloneRowModal 组件

**Files:**
- Create: `webview-ui/src/components/common/CloneRowModal.tsx`

**Step 1: 创建 CloneRowModal 组件**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColumnInfo } from '../../types/database';

interface CloneRowModalProps {
  readonly row: Record<string, unknown>;
  readonly columns: ColumnInfo[];
  readonly onSubmit: (row: Record<string, unknown>) => void;
  readonly onClose: () => void;
}

export function CloneRowModal({ row, columns, onSubmit, onClose }: CloneRowModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const col of columns) {
      const isAutoIncrement = col.extra?.toLowerCase().includes('auto_increment');
      if (isAutoIncrement) {
        initial[col.name] = '';
      } else {
        const v = row[col.name];
        initial[col.name] = v === null || v === undefined ? '' : String(v);
      }
    }
    return initial;
  });
  const [nullFlags, setNullFlags] = useState<Record<string, boolean>>(() => {
    const flags: Record<string, boolean> = {};
    for (const col of columns) {
      const isAutoIncrement = col.extra?.toLowerCase().includes('auto_increment');
      flags[col.name] = !isAutoIncrement && (row[col.name] === null || row[col.name] === undefined);
    }
    return flags;
  });
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const handleChange = useCallback((colName: string, value: string) => {
    setValues((prev) => ({ ...prev, [colName]: value }));
    setNullFlags((prev) => ({ ...prev, [colName]: false }));
  }, []);

  const handleNullToggle = useCallback((colName: string) => {
    setNullFlags((prev) => {
      const next = { ...prev, [colName]: !prev[colName] };
      if (next[colName]) {
        setValues((v) => ({ ...v, [colName]: '' }));
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    const result: Record<string, unknown> = {};
    for (const col of columns) {
      const isAutoIncrement = col.extra?.toLowerCase().includes('auto_increment');
      if (isAutoIncrement && values[col.name] === '') {
        // 跳过 auto_increment 空值, 让数据库自动生成
        continue;
      }
      if (nullFlags[col.name]) {
        result[col.name] = null;
      } else {
        result[col.name] = values[col.name];
      }
    }
    onSubmit(result);
  }, [columns, values, nullFlags, onSubmit]);

  return (
    <div className="clone-row-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="clone-row-modal">
        <div className="clone-row-header">Clone as New Row</div>
        <div className="clone-row-body">
          {columns.map((col) => {
            const isAutoIncrement = col.extra?.toLowerCase().includes('auto_increment');
            const isNull = nullFlags[col.name];
            return (
              <div key={col.name} className="clone-row-field">
                <div className="clone-row-field-label">
                  <span className="clone-row-field-name">{col.name}</span>
                  <span className="clone-row-field-type">
                    {col.dataType}
                    {col.isPrimaryKey && <span className="column-badge pk">PK</span>}
                    {isAutoIncrement && <span className="column-badge auto">AUTO</span>}
                  </span>
                </div>
                <div className="clone-row-field-input">
                  <input
                    type="text"
                    value={isNull ? '' : values[col.name]}
                    placeholder={isAutoIncrement ? 'AUTO' : col.nullable ? 'NULL' : ''}
                    disabled={isNull}
                    onChange={(e) => handleChange(col.name, e.target.value)}
                  />
                  {col.nullable && (
                    <label className="clone-row-null-toggle">
                      <input
                        type="checkbox"
                        checked={isNull}
                        onChange={() => handleNullToggle(col.name)}
                      />
                      NULL
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="clone-row-footer">
          <button className="clone-row-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="clone-row-btn-insert" onClick={handleSubmit}>Insert</button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: 验证文件创建无语法错误**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: 无错误 (或仅与此文件无关的已有错误)

**Step 3: Commit**

```bash
git add webview-ui/src/components/common/CloneRowModal.tsx
git commit -m "feat(clone-row): add CloneRowModal component"
```

---

### Task 2: Modal 样式

**Files:**
- Modify: `webview-ui/src/styles/data-grid.css` (追加到文件末尾, 约 line 348 之后)

**Step 1: 追加样式**

在 `data-grid.css` 末尾追加:

```css
/* --- Clone Row Modal --- */

.clone-row-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background-color: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}

.clone-row-modal {
  background-color: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  width: 480px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.clone-row-header {
  padding: 12px 16px;
  font-weight: 600;
  font-size: 14px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.clone-row-body {
  padding: 12px 16px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.clone-row-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.clone-row-field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.clone-row-field-name {
  font-weight: 600;
}

.clone-row-field-type {
  color: var(--vscode-descriptionForeground);
  display: flex;
  align-items: center;
  gap: 4px;
}

.clone-row-field-type .column-badge.auto {
  background-color: var(--vscode-editorWarning-foreground, #cca700);
  color: var(--vscode-editor-background);
  font-size: 9px;
  font-weight: 700;
  padding: 0 3px;
  border-radius: 2px;
  line-height: 14px;
}

.clone-row-field-input {
  display: flex;
  align-items: center;
  gap: 8px;
}

.clone-row-field-input input[type="text"] {
  flex: 1;
  padding: 4px 8px;
  font-size: 13px;
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  font-family: var(--vscode-editor-font-family);
}

.clone-row-field-input input[type="text"]:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.clone-row-field-input input[type="text"]:disabled {
  opacity: 0.5;
}

.clone-row-null-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}

.clone-row-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.clone-row-btn-cancel {
  padding: 4px 12px;
  font-size: 13px;
}

.clone-row-btn-insert {
  padding: 4px 12px;
  font-size: 13px;
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.clone-row-btn-insert:hover {
  background-color: var(--vscode-button-hoverBackground);
}
```

**Step 2: Commit**

```bash
git add webview-ui/src/styles/data-grid.css
git commit -m "style(clone-row): add CloneRowModal styles"
```

---

### Task 3: 集成到 QueryResultsGrid 右键菜单

**Files:**
- Modify: `webview-ui/src/components/query-editor/QueryResultsGrid.tsx`

**关键点:** 右键菜单目前的 `handleContextMenu` (line 123) 不知道右键的是哪一行. 需要改为在行级别触发, 记录右键行的数据.

**Step 1: 修改 QueryResultsGrid**

1. 新增 props: `onInsertRow` 回调
2. 新增 state: `cloneRow` (记录要克隆的行)
3. 改 `handleContextMenu` 为接收 rowIndex 参数
4. 右键菜单加 "Clone as New Row" 项
5. 渲染 CloneRowModal

修改 `QueryResultsGridProps` (line 20-32), 增加:

```typescript
readonly onInsertRow?: (row: Record<string, unknown>) => void;
```

修改函数签名 (line 40-52), 解构新增 `onInsertRow`.

新增 state (line 55 附近):

```typescript
const [cloneRow, setCloneRow] = useState<Record<string, unknown> | null>(null);
```

修改 `handleContextMenu` (line 123-126), 改为接收 rowIndex:

```typescript
const [contextMenuRowIndex, setContextMenuRowIndex] = useState<number | null>(null);

const handleContextMenu = useCallback((e: React.MouseEvent, rowIndex?: number) => {
  e.preventDefault();
  setContextMenu({ x: e.clientX, y: e.clientY });
  setContextMenuRowIndex(rowIndex ?? null);
}, []);
```

修改 `contextMenuItems` (line 132-143), 增加 Clone as New Row:

```typescript
const contextMenuItems: ContextMenuItem[] = useMemo(() => [
  {
    label: 'Clone as New Row',
    disabled: contextMenuRowIndex === null || !editable || !onInsertRow,
    action: () => {
      if (contextMenuRowIndex !== null) {
        setCloneRow(rows[contextMenuRowIndex]);
      }
    },
  },
  {
    label: 'Export',
    children: [
      {
        label: 'CSV',
        disabled: selectedIndices.length === 0 || !onExportCsv,
        action: handleExportCsv,
      },
    ],
  },
], [contextMenuRowIndex, editable, onInsertRow, rows, selectedIndices.length, onExportCsv, handleExportCsv]);
```

处理 Modal 提交:

```typescript
const handleCloneSubmit = useCallback((row: Record<string, unknown>) => {
  onInsertRow?.(row);
  setCloneRow(null);
}, [onInsertRow]);
```

在 return JSX (line 191-197 contextMenu 渲染后), 追加 CloneRowModal:

```tsx
{cloneRow && onInsertRow && (
  <CloneRowModal
    row={cloneRow}
    columns={columns}
    onSubmit={handleCloneSubmit}
    onClose={() => setCloneRow(null)}
  />
)}
```

**Step 2: 修改 GridTable 传递右键事件**

在 GridTable 的 `<tr>` (line 422-427), 把 `onContextMenu` 从外层 div 移到行级别:

- 移除外层 `query-results-table` div 上的 `onContextMenu={handleContextMenu}` (line 173)
- GridTable 新增 prop: `onRowContextMenu: (e: React.MouseEvent, rowIndex: number) => void`
- 在 `<tr>` 上加 `onContextMenu={(e) => onRowContextMenu(e, row.index)}`

**Step 3: 验证编译**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: 无错误

**Step 4: Commit**

```bash
git add webview-ui/src/components/query-editor/QueryResultsGrid.tsx
git commit -m "feat(clone-row): add Clone as New Row to context menu"
```

---

### Task 4: QueryEditor 提供 onInsertRow 回调

**Files:**
- Modify: `webview-ui/src/components/query-editor/QueryEditor.tsx` (line 264-276)

**Step 1: 添加 handleInsertRow 回调**

在 QueryEditor 中 (line 149 附近, handleBatchSave 之后) 添加:

```typescript
const handleInsertRow = useCallback(
  (row: Record<string, unknown>) => {
    if (!table) return;
    postMessage({ type: 'insertRow', database, table, row });
    // 延迟刷新
    setTimeout(() => {
      const sql = buildSelectSql(table, fullColumns, sortState);
      postMessage({ type: 'executeQuery', database, sql });
    }, 200);
  },
  [table, database, postMessage, fullColumns, sortState]
);
```

**Step 2: 传递给 QueryResultsGrid**

修改 `<QueryResultsGrid>` (line 264-276), 添加 prop:

```tsx
onInsertRow={editable ? handleInsertRow : undefined}
```

**Step 3: 验证编译**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: 无错误

**Step 4: Commit**

```bash
git add webview-ui/src/components/query-editor/QueryEditor.tsx
git commit -m "feat(clone-row): wire onInsertRow from QueryEditor to QueryResultsGrid"
```

---

### Task 5: 构建并手动验证

**Step 1: 构建 webview**

Run: `cd webview-ui && npm run build`
Expected: 构建成功

**Step 2: 构建 extension**

Run: `npm run build`
Expected: 构建成功

**Step 3: 手动测试**

1. 连接 MySQL, 打开一个有数据的表
2. 右键一行, 看到 "Clone as New Row" 菜单项
3. 点击, 弹出 Modal, 检查:
   - AUTO_INCREMENT 列为空, placeholder 显示 AUTO
   - 其余列预填原始数据
   - NULL 值的列可勾选 NULL checkbox
4. 修改某些值, 点 Insert
5. 验证新行已插入
6. 非 editable 模式下 (无 PK 的表) 菜单项应 disabled

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(clone-row): Clone as New Row feature complete"
```
