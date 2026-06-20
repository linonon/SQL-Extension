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
import { generateCsv } from '../../utils/csv';
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
  readonly saving: boolean;
  readonly onSave: (updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]) => void;
  readonly sortState?: SortState | null;
  readonly onSort?: (columnId: string) => void;
  readonly onExportCsv?: (content: string, defaultFileName: string) => void;
  readonly onInsertRow?: (row: Record<string, unknown>) => void;
}

interface EditingCell {
  readonly rowIndex: number;
  readonly columnId: string;
  readonly value: string;
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
  saving,
  onSave,
  sortState,
  onSort,
  onExportCsv,
  onInsertRow,
}: QueryResultsGridProps) {
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number | null } | null>(null);
  const [cloneRow, setCloneRow] = useState<Record<string, unknown> | null>(null);
  const [cellError, setCellError] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { addChange, isCellChanged, getCellValue, buildUpdates, clearChanges, pendingCount } =
    useBatchEdits();

  // rows 引用变化 (save/insert 成功后 re-query, 或用户重跑查询) -> 清空 pending + selection.
  // 排序触发的重跑已在 handleSortGuarded 拦截 (有未保存编辑时不放行), 避免此处静默丢弃草稿.
  useEffect(() => {
    clearChanges();
    setRowSelection({});
  }, [rows, clearChanges]);

  const handleSave = useCallback(() => {
    const updates = buildUpdates(rows, columns);
    if (updates.length > 0) {
      onSave(updates);
    }
  }, [buildUpdates, rows, columns, onSave]);

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

  const handleCellDoubleClick = useCallback(
    (rowIndex: number, columnId: string) => {
      if (!editable) return;
      const value = getCellValue(rowIndex, columnId, rows[rowIndex]?.[columnId]);
      setEditingCell({
        rowIndex,
        columnId,
        value: value === null || value === undefined ? '' : String(value),
      });
    },
    [editable, rows, getCellValue]
  );

  const commitEdit = useCallback(() => {
    if (!editingCell) return;
    const row = rows[editingCell.rowIndex];
    if (!row) {
      setEditingCell(null);
      return;
    }
    const oldValue = row[editingCell.columnId];
    const newValue = editingCell.value === '' ? null : editingCell.value;
    // 提交前值校验: 拦非数字/非法日期等静默写错值
    const editedCol = columns.find((c) => c.name === editingCell.columnId);
    if (editedCol) {
      const problem = validateCellValue(editedCol, newValue);
      if (problem) {
        setCellError(problem);
        setEditingCell(null);
        return;
      }
    }
    setCellError(null);
    addChange(editingCell.rowIndex, editingCell.columnId, oldValue, newValue);
    setEditingCell(null);
  }, [editingCell, rows, columns, addChange]);

  const selectedIndices = useMemo(
    () => Object.keys(rowSelection).filter((k) => rowSelection[k]).map(Number),
    [rowSelection]
  );

  const handleCloneSubmit = useCallback((row: Record<string, unknown>) => {
    onInsertRow?.(row);
    setCloneRow(null);
  }, [onInsertRow]);

  // 排序会重跑查询并刷新 rows, 进而清空未保存的 pending 编辑; 有未保存改动时先拦, 避免静默丢失
  const handleSortGuarded = useCallback(
    (columnId: string) => {
      if (pendingCount > 0) {
        setCellError(`有 ${pendingCount} 处未保存编辑, 请先保存 (Cmd+S) 或撤销后再排序`);
        return;
      }
      setCellError(null);
      onSort?.(columnId);
    },
    [pendingCount, onSort]
  );

  const handleExportCsv = useCallback(() => {
    if (selectedIndices.length === 0 || !onExportCsv) return;
    const selectedRows = selectedIndices.map((i) => rows[i]).filter(Boolean);
    const content = generateCsv(columns, selectedRows);
    onExportCsv(content, 'export.csv');
  }, [selectedIndices, rows, columns, onExportCsv]);

  const handleContextMenu = useCallback((e: React.MouseEvent, rowIndex?: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, rowIndex: rowIndex ?? null });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // 自增/序列/表达式默认值列不预填, 交给 DB 应用默认 (CloneRowModal 仍展示全部列供编辑)
  const emptyRow = useMemo(() => buildInsertRow(columns), [columns]);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    const rowIndex = contextMenu?.rowIndex ?? null;
    return [
      {
        label: 'Insert New Row',
        disabled: !editable || !onInsertRow,
        action: () => {
          setCloneRow(emptyRow);
        },
      },
      {
        label: 'Clone as New Row',
        disabled: rowIndex === null || !editable || !onInsertRow,
        action: () => {
          if (rowIndex !== null) {
            setCloneRow(rows[rowIndex]);
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
    ];
  }, [contextMenu?.rowIndex, editable, onInsertRow, emptyRow, rows, selectedIndices.length, onExportCsv, handleExportCsv]);

  if (error) {
    return <div className="query-results-error">{error}</div>;
  }

  const hasRows = columns.length > 0 && rows.length > 0;

  if (!hasRows) {
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
        saving={saving}
        onSave={handleSave}
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
      <div className="query-results-table" ref={scrollContainerRef}>
        <GridTable
          columns={columns}
          rows={rows}
          editable={editable}
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
          onRowContextMenu={handleContextMenu}
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
          row={cloneRow}
          columns={columns}
          onSubmit={handleCloneSubmit}
          onClose={() => setCloneRow(null)}
        />
      )}
    </div>
  );
}

// 内部表格组件, 使用 TanStack React Table + 虚拟滚动
interface GridTableProps {
  readonly columns: ColumnInfo[];
  readonly rows: Record<string, unknown>[];
  readonly editable: boolean;
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
  readonly onRowContextMenu: (e: React.MouseEvent, rowIndex: number) => void;
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
  editable,
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
  onRowContextMenu,
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
              className={isSelected ? 'row-selected' : ''}
              style={{ height: virtualRow.size }}
              onContextMenu={(e) => onRowContextMenu(e, row.index)}
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
                      <input
                        autoFocus
                        value={editingCell.value}
                        onChange={(e) =>
                          setEditingCell((prev) =>
                            prev ? { ...prev, value: e.target.value } : null
                          )
                        }
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit();
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
                    className={classNames}
                    style={{ width: cell.column.getSize() }}
                    onDoubleClick={() => editable && onCellDoubleClick(rowIndex, colId)}
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
