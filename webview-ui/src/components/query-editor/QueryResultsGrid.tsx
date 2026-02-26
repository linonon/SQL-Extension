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
import { generateCsv } from '../../utils/csv';
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
  readonly editable: boolean;
  readonly saving: boolean;
  readonly onSave: (updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]) => void;
  readonly sortState?: SortState | null;
  readonly onSort?: (columnId: string) => void;
  readonly onExportCsv?: (content: string, defaultFileName: string) => void;
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
  editable,
  saving,
  onSave,
  sortState,
  onSort,
  onExportCsv,
}: QueryResultsGridProps) {
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const { addChange, isCellChanged, getCellValue, buildUpdates, clearChanges, pendingCount } =
    useBatchEdits();

  // rows 引用变化(save 成功后 re-query) -> 清空 pending + selection
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
    addChange(editingCell.rowIndex, editingCell.columnId, oldValue, newValue);
    setEditingCell(null);
  }, [editingCell, rows, addChange]);

  const selectedIndices = useMemo(
    () => Object.keys(rowSelection).filter((k) => rowSelection[k]).map(Number),
    [rowSelection]
  );

  const handleExportCsv = useCallback(() => {
    if (selectedIndices.length === 0 || !onExportCsv) return;
    const selectedRows = selectedIndices.map((i) => rows[i]).filter(Boolean);
    const content = generateCsv(columns, selectedRows);
    onExportCsv(content, 'export.csv');
  }, [selectedIndices, rows, columns, onExportCsv]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => [
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
  ], [selectedIndices.length, onExportCsv, handleExportCsv]);

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

  const scrollContainerRef = useRef<HTMLDivElement>(null);

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
      <div className="query-results-table" ref={scrollContainerRef} onContextMenu={handleContextMenu}>
        <GridTable
          columns={columns}
          rows={rows}
          editable={editable}
          editingCell={editingCell}
          setEditingCell={setEditingCell}
          isCellChanged={isCellChanged}
          getCellValue={getCellValue}
          onCellDoubleClick={handleCellDoubleClick}
          commitEdit={commitEdit}
          sortState={sortState}
          onSort={onSort}
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
  readonly getCellValue: (rowIndex: number, columnId: string, originalValue: unknown) => unknown;
  readonly onCellDoubleClick: (rowIndex: number, columnId: string) => void;
  readonly commitEdit: () => void;
  readonly sortState?: SortState | null;
  readonly onSort?: (columnId: string) => void;
  readonly rowSelection: Record<string, boolean>;
  readonly onRowSelectionChange: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  readonly scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

// DOM 测量列内容最大宽度, 从真实渲染元素读 computedStyle 获取 font
// columnIndex 相对于数据列 (跳过 checkbox 列)
function measureColumnFitWidth(tableEl: HTMLTableElement, columnIndex: number): number {
  // +1 因为第一列是 checkbox
  const domIndex = columnIndex + 1;
  const span = document.createElement('span');
  span.style.visibility = 'hidden';
  span.style.position = 'absolute';
  span.style.whiteSpace = 'nowrap';
  document.body.appendChild(span);

  let maxWidth = 0;

  // 测量 header
  const th = tableEl.querySelector(`thead tr th:nth-child(${domIndex + 1})`);
  if (th) {
    const computed = getComputedStyle(th);
    span.style.font = computed.font;
    const nameEl = th.querySelector('.column-name');
    span.textContent = nameEl?.textContent ?? '';
    let headerWidth = span.offsetWidth;

    const typeEl = th.querySelector('.column-type');
    if (typeEl) {
      span.textContent = typeEl.textContent ?? '';
      const tw = span.offsetWidth;
      if (tw > headerWidth) headerWidth = tw;
    }
    maxWidth = headerWidth;
  }

  // 测量 body 所有行
  const cells = tableEl.querySelectorAll(`tbody tr td:nth-child(${domIndex + 1})`);
  for (const td of cells) {
    const computed = getComputedStyle(td);
    span.style.font = computed.font;
    span.textContent = td.textContent ?? '';
    const w = span.offsetWidth;
    if (w > maxWidth) maxWidth = w;
  }

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
      sizing[columns[i].name] = measureColumnFitWidth(el, i);
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
                    const fitWidth = measureColumnFitWidth(tableRef.current, colIndex);
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
                  changed ? 'cell-changed' : '',
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
