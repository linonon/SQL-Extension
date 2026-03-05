# Clone Row as New Record - Design

## Overview

MySQL webview 查询结果表格新增右键菜单 "Clone as New Row", 弹出表单对话框, 基于选中行数据预填, 用户编辑后插入新记录.

## Scope

- 仅 MySQL
- 仅 QueryResultsGrid (查询结果表格)

## 交互流程

1. 用户右键表格中某一行
2. 右键菜单出现 "Clone as New Row" 选项
3. 点击后弹出 Modal 表单:
   - 每列一行: 列名 / 类型 / 输入框 (预填当前值)
   - AUTO_INCREMENT 列自动清空, 标记为 "auto"
   - PK 列高亮提示
   - NULL 值显示为空, 可输入
4. 用户编辑完成后点 "Insert" 按钮
5. 发送 `insertRow` 消息到 extension host
6. Extension host 执行 INSERT SQL
7. 刷新表格

## 技术方案

### 新建文件

- `webview-ui/src/components/common/CloneRowModal.tsx` — 表单弹窗组件

### 修改文件

- `webview-ui/src/components/query-editor/QueryResultsGrid.tsx` — 右键菜单加 "Clone as New Row", 管理 Modal 状态
- `webview-ui/src/styles/data-grid.css` — Modal 样式 (复用 VS Code 主题变量)

### 数据流

```
QueryResultsGrid (右键行)
  → setState({ cloneModal: { row, columns } })
  → <CloneRowModal row={row} columns={columns} onSubmit={...} onClose={...} />
  → onSubmit(editedRow)
  → postMessage({ type: 'insertRow', database, table, row: editedRow })
  → table-view-provider.ts handleMessage('insertRow')
  → 执行 INSERT SQL
  → 刷新
```

### CloneRowModal Props

```typescript
interface CloneRowModalProps {
  row: Record<string, unknown>;        // 原始行数据
  columns: ColumnInfo[];               // 列元数据
  onSubmit: (row: Record<string, unknown>) => void;
  onClose: () => void;
}
```

### AUTO_INCREMENT 处理

从 `ColumnInfo.extra` 判断是否包含 `auto_increment`, 若是则:
- 输入框预设为空
- placeholder 显示 "AUTO"
- 用户可覆盖输入

### 复用

- 消息类型: 复用现有 `insertRow`
- Extension host: 不需要改动 `table-view-provider.ts`
- 样式: 复用 VS Code 主题变量 (`--vscode-input-*`, `--vscode-button-*`)
