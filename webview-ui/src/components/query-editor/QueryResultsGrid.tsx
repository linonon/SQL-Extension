import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBatchEdits } from '../../hooks/useBatchEdits';
import { QueryResultsToolbar } from './QueryResultsToolbar';
import { ContextMenu } from '../common/ContextMenu';
import type { ContextMenuItem } from '../common/ContextMenu';
import { CloneRowModal } from '../common/CloneRowModal';
import { CellValueModal } from '../common/CellValueModal';
import { generateCsv, generateTsv } from '../../utils/csv';
import { buildInsertSql } from '../../utils/insert-sql';
import { buildInsertRow } from '../../utils/insert-row';
import { validateCellValue } from '../../utils/cell-value-validator';
import { widestCellSample, MAX_FIT_CHARS } from '../../utils/column-fit';
import type { ColumnInfo } from '../../types/database';
import type { SortState } from '../../utils/sql-builder';

const ROW_HEIGHT = 32;
const OVERSCAN = 10;

interface QueryResultsGridProps {
  readonly columns: ColumnInfo[];
  readonly rows: Record<string, unknown>[];
  readonly affectedRows: number;
  readonly executionTime: number;
  readonly error?: string;
  // 保存失败的错误: 行内提示, 不替换结果表 (区别于 error = 查询执行失败, 无表可展示)
  readonly saveError?: string;
  readonly onDismissSaveError?: () => void;
  readonly editable: boolean;
  // 不可编辑时展示给用户的原因
  readonly readOnlyReason?: string;
  readonly saving: boolean;
  readonly onSave: (updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]) => void;
  readonly sortState?: SortState | null;
  readonly onSort?: (columnId: string) => void;
  readonly onExportCsv?: (content: string, defaultFileName: string) => void;
  readonly onInsertRow?: (row: Record<string, unknown>) => void;
  // panel 表的全部列: Insert / Clone 表单按它出字段 (结果集可能没选出 NOT NULL 列)
  readonly tableColumns?: ColumnInfo[];
  // 未保存编辑数变化时通知父组件, 供重跑查询 / 切表前确认
  readonly onPendingCountChange?: (count: number) => void;
  // 工具栏附加说明 (如只对已加载的行做了排序)
  readonly note?: string;
  // 宿主截掉了结果集尾部: rows 不是语句返回的全部行
  readonly truncated?: boolean;
  // Copy as INSERT 的方言与目标表 (不传表时取结果列的唯一来源表)
  readonly driverType?: string;
  readonly table?: string;
  // 传了才有 Delete 菜单: 按主键删行, 宿主确认后执行
  readonly onDeleteRows?: (primaryKeys: Record<string, unknown>[]) => void;
}

interface EditingCell {
  readonly rowIndex: number;
  readonly columnId: string;
  readonly value: string;
  // 是否动过编辑框: 没动过提交等于不变 (NULL 格子打开是空串, 不能因此变成 ''; 动过再清空才是 '')
  readonly dirty: boolean;
}

export function QueryResultsGrid({
  columns,
  rows,
  affectedRows,
  executionTime,
  error,
  saveError,
  onDismissSaveError,
  editable,
  readOnlyReason,
  saving,
  onSave,
  sortState,
  onSort,
  onExportCsv,
  onInsertRow,
  tableColumns,
  onPendingCountChange,
  note,
  truncated,
  driverType,
  table,
  onDeleteRows,
}: QueryResultsGridProps) {
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number | null; columnId: string | null } | null>(null);
  const [cloneRow, setCloneRow] = useState<{ readonly title: string; readonly row: Record<string, unknown> } | null>(null);
  const [viewCell, setViewCell] = useState<{ readonly rowIndex: number; readonly columnId: string } | null>(null);
  const [cellError, setCellError] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { addChange, isCellChanged, getCellValue, buildUpdates, clearChanges, pendingCount } =
    useBatchEdits();

  // rows 引用变化 (save/insert 成功后 re-query, 或用户重跑查询) -> 清空 pending, selection 和打开的值弹窗 (行下标已失效).
  // 排序在 handleSortGuarded 拦截, 重跑查询 / 切表由上层按 onPendingCountChange 先确认, 避免此处静默丢弃草稿.
  useEffect(() => {
    clearChanges();
    setRowSelection({});
    setViewCell(null);
  }, [rows, clearChanges]);

  useEffect(() => {
    onPendingCountChange?.(pendingCount);
  }, [pendingCount, onPendingCountChange]);

  // 撤销所有未保存编辑: 清空 pending (单元格恢复原值, 无需重跑 query), 并清掉错误提示
  const handleDiscard = useCallback(() => {
    clearChanges();
    setEditingCell(null);
    setCellError(null);
    onDismissSaveError?.();
  }, [clearChanges, onDismissSaveError]);

  // 可编辑网格双击就地编辑, 只读网格双击打开完整值弹窗
  const handleCellDoubleClick = useCallback(
    (rowIndex: number, columnId: string) => {
      if (!editable) {
        setViewCell({ rowIndex, columnId });
        return;
      }
      const value = getCellValue(rowIndex, columnId, rows[rowIndex]?.[columnId]);
      const text = value === null || value === undefined ? '' : String(value);
      setEditingCell({ rowIndex, columnId, value: text, dirty: false });
    },
    [editable, rows, getCellValue]
  );

  // 提交编辑中的格子, 校验不过返回 false. 编辑框里的文本原样作为新值 (空串就是 '', 置 NULL 走右键 Set NULL)
  const commitEdit = useCallback((): boolean => {
    if (!editingCell) return true;
    const row = rows[editingCell.rowIndex];
    if (!row || !editingCell.dirty) {
      setEditingCell(null);
      return true;
    }
    const newValue = editingCell.value;
    // 提交前值校验: 拦非数字/非法日期等静默写错值
    const editedCol = columns.find((c) => c.name === editingCell.columnId);
    if (editedCol) {
      const problem = validateCellValue(editedCol, newValue);
      if (problem) {
        setCellError(problem);
        setEditingCell(null);
        return false;
      }
    }
    setCellError(null);
    addChange(editingCell.rowIndex, editingCell.columnId, row[editingCell.columnId], newValue);
    setEditingCell(null);
    return true;
  }, [editingCell, rows, columns, addChange]);

  // 还在编辑态的格子先提交再存, 校验不过不存
  const handleSave = useCallback(() => {
    if (!commitEdit()) return;
    const updates = buildUpdates(rows, columns);
    if (updates.length > 0) {
      onSave(updates);
    }
  }, [commitEdit, buildUpdates, rows, columns, onSave]);

  // Cmd+S / Ctrl+S 快捷键
  useEffect(() => {
    if (!editable) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editable, handleSave]);

  const selectedIndices = useMemo(
    () => Object.keys(rowSelection).filter((k) => rowSelection[k]).map(Number),
    [rowSelection]
  );

  const handleCloneSubmit = useCallback((row: Record<string, unknown>) => {
    onInsertRow?.(row);
    setCloneRow(null);
  }, [onInsertRow]);

  // 排序 (服务端重跑或内存重排) 与插入成功后的刷新都会替换 rows; pending 编辑按行下标记录, 随之清空, 有未保存改动时先拦
  const rejectIfPending = useCallback(
    (what: string): boolean => {
      if (pendingCount === 0) return false;
      setCellError(`有 ${pendingCount} 处未保存编辑, 请先保存 (Cmd+S) 或撤销后再${what}`);
      return true;
    },
    [pendingCount]
  );

  const handleSortGuarded = useCallback(
    (columnId: string) => {
      if (rejectIfPending('排序')) return;
      setCellError(null);
      onSort?.(columnId);
    },
    [rejectIfPending, onSort]
  );

  // 有勾选行导出勾选行, 否则导出全部已加载的行
  const handleExportCsv = useCallback(() => {
    if (!onExportCsv) return;
    const exportRows = selectedIndices.length > 0 ? selectedIndices.map((i) => rows[i]).filter(Boolean) : rows;
    onExportCsv(generateCsv(columns, exportRows), 'export.csv');
  }, [selectedIndices, rows, columns, onExportCsv]);

  // 挂在滚动容器上: 空表 / 空白处也能右键 Insert; 行和列从被点的元素上取
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // 编辑框保留原生菜单 (复制 / 粘贴)
    if (target.closest('td.editing')) return;
    e.preventDefault();
    const row = target.closest<HTMLElement>('tr[data-row]')?.dataset.row;
    const col = target.closest<HTMLElement>('td[data-col]')?.dataset.col;
    setContextMenu({ x: e.clientX, y: e.clientY, rowIndex: row === undefined ? null : Number(row), columnId: col ?? null });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setCellError('复制失败: 剪贴板不可用');
    }
  }, []);

  // 单元格值弹窗里 Apply / Set NULL: 和就地编辑一样记成待保存的改动
  const handleViewCellSave = useCallback((value: string | null) => {
    if (viewCell) addChange(viewCell.rowIndex, viewCell.columnId, rows[viewCell.rowIndex]?.[viewCell.columnId], value);
    setViewCell(null);
  }, [viewCell, rows, addChange]);

  const formColumns = tableColumns && tableColumns.length > 0 ? tableColumns : columns;
  // 自增/序列/表达式默认值列不预填, 交给 DB 应用默认 (CloneRowModal 仍展示全部列供编辑)
  const emptyRow = useMemo(() => buildInsertRow(formColumns), [formColumns]);

  // Copy as INSERT 的目标表: panel 表, 否则结果列都来自同一张表时取它
  const sourceTable = columns[0]?.source?.table;
  const insertTable = table ?? (sourceTable && columns.every((c) => c.source?.table === sourceTable) ? sourceTable : 'table_name');

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    const rowIndex = contextMenu?.rowIndex ?? null;
    const columnId = contextMenu?.columnId ?? null;
    const cellCol = columnId === null ? undefined : columns.find((c) => c.name === columnId);
    const cellValue = rowIndex === null || columnId === null ? null : getCellValue(rowIndex, columnId, rows[rowIndex]?.[columnId]);
    // Copy / Delete 的对象: 有勾选行取勾选行, 否则取右键点中的那一行
    const targets = selectedIndices.length > 0 ? selectedIndices : rowIndex === null ? [] : [rowIndex];
    const targetNote = selectedIndices.length > 0 ? ` (${selectedIndices.length} selected)` : '';
    // 复制的是网格上看到的值 (含未保存的编辑)
    const targetRows = () => targets.map((i) => Object.fromEntries(columns.map((c) => [c.name, getCellValue(i, c.name, rows[i]?.[c.name])])));
    const pkColumns = columns.filter((c) => c.isPrimaryKey);
    return [
      {
        label: 'View Value',
        disabled: rowIndex === null || columnId === null,
        action: () => {
          if (rowIndex !== null && columnId !== null) setViewCell({ rowIndex, columnId });
        },
      },
      {
        label: 'Copy',
        children: [
          {
            label: 'Copy Cell',
            disabled: rowIndex === null || columnId === null,
            action: () => { void copyText(cellValue === null || cellValue === undefined ? 'NULL' : String(cellValue)); },
          },
          {
            label: `Copy Rows${targetNote}`,
            disabled: targets.length === 0,
            action: () => { void copyText(generateTsv(columns, targetRows())); },
          },
          {
            label: `Copy as INSERT${targetNote}`,
            disabled: targets.length === 0 || !driverType,
            action: () => { void copyText(buildInsertSql(driverType ?? '', insertTable, columns, targetRows())); },
          },
        ],
      },
      {
        label: 'Set NULL',
        disabled: !editable || rowIndex === null || !cellCol?.nullable || cellValue === null || cellValue === undefined,
        action: () => {
          if (rowIndex !== null && columnId !== null) {
            addChange(rowIndex, columnId, rows[rowIndex]?.[columnId], null);
          }
        },
      },
      {
        label: 'Insert New Row',
        disabled: !onInsertRow,
        action: () => {
          if (!rejectIfPending('插入')) setCloneRow({ title: 'Insert New Row', row: emptyRow });
        },
      },
      {
        label: 'Clone as New Row',
        disabled: rowIndex === null || !onInsertRow,
        action: () => {
          if (rowIndex !== null && !rejectIfPending('插入')) {
            // 结果集里有的列取源行的值, 没选出来的列按插入新行的默认值预填
            setCloneRow({ title: 'Clone as New Row', row: { ...emptyRow, ...rows[rowIndex] } });
          }
        },
      },
      // 父组件只在网格可写回 panel 表时给 onDeleteRows
      ...(onDeleteRows ? [{
        label: selectedIndices.length > 0 ? `Delete Selected Rows${targetNote}` : 'Delete Row',
        disabled: targets.length === 0 || pkColumns.length === 0,
        action: () => {
          if (rejectIfPending('删除')) return;
          onDeleteRows(targets.map((i) => Object.fromEntries(pkColumns.map((pk) => [pk.name, rows[i]?.[pk.name]]))));
        },
      }] : []),
      {
        label: 'Export',
        children: [
          {
            label: selectedIndices.length > 0 ? `CSV (${selectedIndices.length} selected)`
              : truncated ? `CSV (first ${rows.length} loaded rows)` : `CSV (all ${rows.length} rows)`,
            disabled: !onExportCsv,
            action: handleExportCsv,
          },
        ],
      },
    ];
  }, [contextMenu?.rowIndex, contextMenu?.columnId, columns, editable, getCellValue, addChange, onInsertRow, rejectIfPending, emptyRow, rows, selectedIndices, onExportCsv, handleExportCsv, truncated, copyText, driverType, insertTable, onDeleteRows]);

  const viewCellColumn = viewCell ? columns.find((c) => c.name === viewCell.columnId) : undefined;

  if (error) {
    return <div className="query-results-error">{error}</div>;
  }

  // 没有列 = 写语句的结果; 有列就渲染表头, 0 行也一样 (空表上能右键 Insert)
  if (columns.length === 0) {
    return (
      <div className="query-results">
        <div className="query-results-info">
          {affectedRows} rows affected in {executionTime}ms
        </div>
      </div>
    );
  }

  return (
    <div className="query-results">
      <QueryResultsToolbar
        rowCount={rows.length}
        executionTime={executionTime}
        pendingCount={pendingCount}
        editable={editable}
        readOnlyReason={readOnlyReason}
        saving={saving}
        onSave={handleSave}
        onDiscard={handleDiscard}
        note={note}
      />
      {saveError && (
        <div className="data-grid-write-error">
          <span>{saveError}</span>
          <button title="Dismiss" onClick={onDismissSaveError}>×</button>
        </div>
      )}
      {cellError && (
        <div className="data-grid-write-error">
          <span>{cellError}</span>
          <button title="Dismiss" onClick={() => setCellError(null)}>×</button>
        </div>
      )}
      <div className="query-results-table" ref={scrollContainerRef} onContextMenu={handleContextMenu}>
        <GridTable
          columns={columns}
          rows={rows}
          editingCell={editingCell}
          setEditingCell={setEditingCell}
          isCellChanged={isCellChanged}
          hasSaveError={!!saveError}
          getCellValue={getCellValue}
          onCellDoubleClick={handleCellDoubleClick}
          commitEdit={commitEdit}
          sortState={sortState}
          onSort={onSort ? handleSortGuarded : undefined}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          scrollContainerRef={scrollContainerRef}
        />
      </div>
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu}
          onClose={closeContextMenu}
        />
      )}
      {cloneRow && onInsertRow && (
        <CloneRowModal
          title={cloneRow.title}
          row={cloneRow.row}
          columns={formColumns}
          onSubmit={handleCloneSubmit}
          onClose={() => setCloneRow(null)}
        />
      )}
      {viewCell && viewCellColumn && (
        <CellValueModal
          column={viewCellColumn}
          value={getCellValue(viewCell.rowIndex, viewCell.columnId, rows[viewCell.rowIndex]?.[viewCell.columnId])}
          onSave={editable ? handleViewCellSave : undefined}
          onClose={() => setViewCell(null)}
        />
      )}
    </div>
  );
}

// 内部表格组件, 使用 TanStack React Table + 虚拟滚动
interface GridTableProps {
  readonly columns: ColumnInfo[];
  readonly rows: Record<string, unknown>[];
  readonly editingCell: EditingCell | null;
  readonly setEditingCell: React.Dispatch<React.SetStateAction<EditingCell | null>>;
  readonly isCellChanged: (rowIndex: number, columnId: string) => boolean;
  // 保存失败时, 待存(已改)单元格高亮转红 (batchUpdate 单事务, 失败=整批未落库)
  readonly hasSaveError: boolean;
  readonly getCellValue: (rowIndex: number, columnId: string, originalValue: unknown) => unknown;
  readonly onCellDoubleClick: (rowIndex: number, columnId: string) => void;
  readonly commitEdit: () => void;
  readonly sortState?: SortState | null;
  readonly onSort?: (columnId: string) => void;
  readonly rowSelection: Record<string, boolean>;
  readonly onRowSelectionChange: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  readonly scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

// 测量列自适应宽度.
// header 从 thead DOM 量 (thead 恒渲染, 能准确算上 PK/NN 徽标与粗体);
// body 从 rows 全量数据量 (而非虚拟滚动下只有可见行的 tbody DOM —— 那会漏掉未渲染行,
// 使列宽塌成表头宽度), 内容截断到 MAX_FIT_CHARS 作为列宽上限.
// columnIndex 相对于数据列 (跳过 checkbox 列)
function measureColumnFitWidth(
  tableEl: HTMLTableElement,
  columnIndex: number,
  rows: readonly Record<string, unknown>[],
  colName: string,
): number {
  // +1 因为第一列是 checkbox
  const domIndex = columnIndex + 1;
  const span = document.createElement('span');
  span.style.visibility = 'hidden';
  span.style.position = 'absolute';
  span.style.whiteSpace = 'nowrap';
  document.body.appendChild(span);

  let maxWidth = 0;

  // 测量 header (name 行含徽标 / type 行)
  const th = tableEl.querySelector(`thead tr th:nth-child(${domIndex + 1})`);
  if (th) {
    span.style.font = getComputedStyle(th).font;
    const nameEl = th.querySelector('.column-name');
    span.textContent = nameEl?.textContent ?? '';
    maxWidth = span.offsetWidth;

    const typeEl = th.querySelector('.column-type');
    if (typeEl) {
      span.textContent = typeEl.textContent ?? '';
      if (span.offsetWidth > maxWidth) maxWidth = span.offsetWidth;
    }
  }

  // 测量 body: 用全量 rows 数据选最宽内容 (截断到上限), 以 body 单元格字体测像素宽
  const sampleTd = tableEl.querySelector(`tbody tr td:nth-child(${domIndex + 1})`);
  span.style.font = getComputedStyle(sampleTd ?? th ?? tableEl).font;
  span.textContent = widestCellSample(rows, colName, MAX_FIT_CHARS);
  if (span.offsetWidth > maxWidth) maxWidth = span.offsetWidth;

  document.body.removeChild(span);
  // 左右 padding + 余量
  return Math.max(maxWidth + 24, 60);
}

function GridTable({
  columns,
  rows,
  editingCell,
  setEditingCell,
  isCellChanged,
  hasSaveError,
  getCellValue,
  onCellDoubleClick,
  commitEdit,
  sortState,
  onSort,
  rowSelection,
  onRowSelectionChange,
  scrollContainerRef,
}: GridTableProps) {
  const columnHelper = createColumnHelper<Record<string, unknown>>();

  const tableRef = useRef<HTMLTableElement>(null);

  const allSelected = rows.length > 0 && rows.every((_, i) => rowSelection[String(i)]);

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      onRowSelectionChange({});
    } else {
      const next: Record<string, boolean> = {};
      for (let i = 0; i < rows.length; i++) {
        next[String(i)] = true;
      }
      onRowSelectionChange(next);
    }
  }, [allSelected, rows.length, onRowSelectionChange]);

  const handleSelectRow = useCallback(
    (rowIndex: number) => {
      onRowSelectionChange((prev) => ({
        ...prev,
        [String(rowIndex)]: !prev[String(rowIndex)],
      }));
    },
    [onRowSelectionChange]
  );

  const tableColumns = columns.map((col) => {
    const isSorted = sortState?.column === col.name;
    const sortDir = isSorted ? sortState.direction : null;
    const sortIndicator = sortDir === 'ASC' ? ' \u25B2' : sortDir === 'DESC' ? ' \u25BC' : '';

    return columnHelper.accessor((row) => row[col.name], {
      id: col.name,
      header: () => (
        <div
          className={`query-grid-header${onSort ? ' sortable' : ''}`}
          onClick={onSort ? () => onSort(col.name) : undefined}
        >
          <span className="column-name">
            {col.name}
            {col.isPrimaryKey && <span className="column-badge pk">PK</span>}
            {!col.nullable && <span className="column-badge nn">NN</span>}
            {sortIndicator && (
              <span className="query-grid-sort-indicator">{sortIndicator}</span>
            )}
          </span>
          <span className="column-type">{col.dataType}</span>
        </div>
      ),
      size: 150,
      minSize: 60,
    });
  });

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  });

  const { rows: tableRows } = table.getRowModel();

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  // 数据渲染后自动适配所有列宽
  useEffect(() => {
    const el = tableRef.current;
    if (!el || columns.length === 0) return;
    const sizing: Record<string, number> = {};
    for (let i = 0; i < columns.length; i++) {
      sizing[columns[i].name] = measureColumnFitWidth(el, i, rows, columns[i].name);
    }
    table.setColumnSizing(sizing);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0
    ? totalSize - virtualItems[virtualItems.length - 1].end
    : 0;

  return (
    <table
      ref={tableRef}
      className="data-grid-table query-grid"
      style={{ width: table.getCenterTotalSize() + 36 }}
    >
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            <th className="select-column">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={handleSelectAll}
              />
            </th>
            {headerGroup.headers.map((header) => (
              <th
                key={header.id}
                style={{ width: header.getSize() }}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
                <div
                  className={`resize-handle ${header.column.getIsResizing() ? 'resizing' : ''}`}
                  onMouseDown={header.getResizeHandler()}
                  onTouchStart={header.getResizeHandler()}
                  onDoubleClick={() => {
                    if (!tableRef.current) return;
                    const colIndex = headerGroup.headers.indexOf(header);
                    const fitWidth = measureColumnFitWidth(tableRef.current, colIndex, rows, header.column.id);
                    table.setColumnSizing((prev) => ({
                      ...prev,
                      [header.column.id]: fitWidth,
                    }));
                  }}
                />
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {paddingTop > 0 && (
          <tr><td style={{ height: paddingTop, padding: 0, border: 'none' }} /></tr>
        )}
        {virtualItems.map((virtualRow) => {
          const row = tableRows[virtualRow.index];
          if (!row) { return null; }
          const isSelected = !!rowSelection[String(row.index)];
          return (
            <tr
              key={row.id}
              data-row={row.index}
              className={isSelected ? 'row-selected' : ''}
              style={{ height: virtualRow.size }}
            >
              <td className="select-column">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleSelectRow(row.index)}
                />
              </td>
              {row.getVisibleCells().map((cell) => {
                const rowIndex = row.index;
                const colId = cell.column.id;
                const isEditing =
                  editingCell?.rowIndex === rowIndex && editingCell?.columnId === colId;
                const changed = isCellChanged(rowIndex, colId);
                const displayValue = getCellValue(rowIndex, colId, cell.getValue());
                const isNull = displayValue === null || displayValue === undefined;
                const colInfo = columns.find((c) => c.name === colId);
                const isPk = colInfo?.isPrimaryKey ?? false;

                if (isEditing) {
                  return (
                    <td key={cell.id} className="editing" style={{ width: cell.column.getSize() }}>
                      <textarea
                        autoFocus
                        rows={1}
                        value={editingCell.value}
                        onChange={(e) =>
                          setEditingCell((prev) =>
                            prev ? { ...prev, value: e.target.value, dirty: true } : null
                          )
                        }
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing) return;
                          // Enter 提交, Shift+Enter 换行, Escape 放弃
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            commitEdit();
                          }
                          if (e.key === 'Escape') setEditingCell(null);
                        }}
                      />
                    </td>
                  );
                }

                const classNames = [
                  isNull ? 'null-value' : '',
                  isPk ? 'pk-column' : '',
                  changed ? (hasSaveError ? 'cell-error' : 'cell-changed') : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <td
                    key={cell.id}
                    data-col={colId}
                    className={classNames}
                    style={{ width: cell.column.getSize() }}
                    onDoubleClick={() => onCellDoubleClick(rowIndex, colId)}
                  >
                    {isNull ? 'NULL' : String(displayValue)}
                  </td>
                );
              })}
            </tr>
          );
        })}
        {paddingBottom > 0 && (
          <tr><td style={{ height: paddingBottom, padding: 0, border: 'none' }} /></tr>
        )}
      </tbody>
    </table>
  );
}
