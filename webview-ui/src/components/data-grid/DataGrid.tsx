import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import { DataGridToolbar } from './DataGridToolbar';
import { DataGridPagination } from './DataGridPagination';
import type { ColumnInfo, PageInfo } from '../../types/database';
import type { ExtensionMessage } from '../../types/messages';
import '../../styles/data-grid.css';

const PAGE_SIZE = 100;
const ROW_HEIGHT = 32;
const OVERSCAN = 10;

interface DataGridProps {
  readonly connectionId: string;
  readonly database: string;
  readonly table: string;
}

interface EditingCell {
  readonly rowIndex: number;
  readonly columnId: string;
  readonly value: string;
}

export function DataGrid({ database, table }: DataGridProps) {
  const postMessage = usePostMessage();
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [page, setPage] = useState<PageInfo>({ offset: 0, limit: PAGE_SIZE, total: 0 });
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(
    (offset: number) => {
      setLoading(true);
      setError(null);
      postMessage({ type: 'fetchRows', database, table, offset, limit: PAGE_SIZE });
    },
    [database, table, postMessage]
  );

  const handleMessage = useCallback(
    (message: ExtensionMessage) => {
      switch (message.type) {
        case 'tableData':
          setColumns(message.columns);
          setRows(message.rows);
          setPage({ offset: message.offset, limit: message.limit, total: message.total });
          setLoading(false);
          setSelectedRows(new Set());
          break;
        case 'error':
          setError(message.message);
          setLoading(false);
          break;
      }
    },
    []
  );

  useVSCodeMessage(handleMessage);

  // mount 时直接拉数据, 不等 viewInit (viewInit 已被 App.tsx 消费)
  useEffect(() => {
    fetchData(0);
  }, [fetchData]);

  // 构建 TanStack Table columns
  const columnHelper = createColumnHelper<Record<string, unknown>>();
  const tableColumns = columns.map((col) =>
    columnHelper.accessor((row) => row[col.name], {
      id: col.name,
      header: () => col.name,
      cell: (info) => {
        const value = info.getValue();
        if (value === null || value === undefined) {
          return <span className="null-value">NULL</span>;
        }
        return String(value);
      },
    })
  );

  const reactTable = useReactTable({
    data: rows,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const pkColumnSet = useMemo(
    () => new Set(columns.filter((c) => c.isPrimaryKey).map((c) => c.name)),
    [columns]
  );

  const { rows: tableRows } = reactTable.getRowModel();

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const handleRowClick = useCallback(
    (index: number, event: React.MouseEvent) => {
      setSelectedRows((prev) => {
        const next = new Set(prev);
        if (event.ctrlKey || event.metaKey) {
          if (next.has(index)) {
            next.delete(index);
          } else {
            next.add(index);
          }
          return next;
        }
        return new Set([index]);
      });
    },
    []
  );

  const handleCellDoubleClick = useCallback(
    (rowIndex: number, columnId: string) => {
      const row = rows[rowIndex];
      if (!row) { return; }
      const value = row[columnId];
      setEditingCell({
        rowIndex,
        columnId,
        value: value === null || value === undefined ? '' : String(value),
      });
    },
    [rows]
  );

  const commitEdit = useCallback(() => {
    if (!editingCell) { return; }
    const row = rows[editingCell.rowIndex];
    if (!row) { return; }

    const oldValue = row[editingCell.columnId];
    const newValue = editingCell.value === '' ? null : editingCell.value;
    if (String(oldValue ?? '') === String(newValue ?? '')) {
      setEditingCell(null);
      return;
    }

    // 构建 primary key map
    const pkColumns = columns.filter((c) => c.isPrimaryKey);
    if (pkColumns.length === 0) {
      setError('Cannot update: no primary key defined');
      setEditingCell(null);
      return;
    }

    const primaryKeys: Record<string, unknown> = {};
    for (const pk of pkColumns) {
      primaryKeys[pk.name] = row[pk.name];
    }

    postMessage({
      type: 'updateRow',
      database,
      table,
      primaryKeys,
      changes: { [editingCell.columnId]: newValue },
    });
    setEditingCell(null);
    // 编辑后刷新当前页
    fetchData(page.offset);
  }, [editingCell, rows, columns, database, table, postMessage, fetchData, page.offset]);

  const handleInsert = useCallback(() => {
    const emptyRow: Record<string, unknown> = {};
    for (const col of columns) {
      emptyRow[col.name] = col.defaultValue;
    }
    postMessage({ type: 'insertRow', database, table, row: emptyRow });
    // 刷新当前页
    setTimeout(() => fetchData(page.offset), 200);
  }, [columns, database, table, postMessage, fetchData, page.offset]);

  const handleDelete = useCallback(() => {
    const pkColumns = columns.filter((c) => c.isPrimaryKey);
    if (pkColumns.length === 0) {
      setError('Cannot delete: no primary key defined');
      return;
    }

    const keysToDelete: Record<string, unknown>[] = [];
    for (const idx of selectedRows) {
      const row = rows[idx];
      if (!row) { continue; }
      const pks: Record<string, unknown> = {};
      for (const pk of pkColumns) {
        pks[pk.name] = row[pk.name];
      }
      keysToDelete.push(pks);
    }

    if (keysToDelete.length > 0) {
      postMessage({ type: 'deleteRows', database, table, primaryKeys: keysToDelete });
      setTimeout(() => fetchData(page.offset), 200);
    }
  }, [columns, selectedRows, rows, database, table, postMessage, fetchData, page.offset]);

  const handlePageChange = useCallback(
    (newOffset: number) => {
      const clamped = Math.max(0, newOffset);
      fetchData(clamped);
    },
    [fetchData]
  );

  if (loading && rows.length === 0) {
    return <div className="data-grid-loading">Loading...</div>;
  }

  if (error) {
    return (
      <div className="data-grid-container">
        <DataGridToolbar
          tableName={table}
          onRefresh={() => fetchData(page.offset)}
          onInsert={handleInsert}
          onDelete={handleDelete}
          hasSelection={selectedRows.size > 0}
        />
        <div className="data-grid-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="data-grid-container">
      <DataGridToolbar
        tableName={table}
        onRefresh={() => fetchData(page.offset)}
        onInsert={handleInsert}
        onDelete={handleDelete}
        hasSelection={selectedRows.size > 0}
      />
      <div className="data-grid-wrapper" ref={tableContainerRef}>
        <table className="data-grid-table">
          <thead>
            {reactTable.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    style={{ width: header.getSize() }}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    <span className="sort-indicator">
                      {{ asc: ' ^', desc: ' v' }[header.column.getIsSorted() as string] ?? ''}
                    </span>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = tableRows[virtualRow.index];
              if (!row) { return null; }
              const isSelected = selectedRows.has(virtualRow.index);
              return (
                <tr
                  key={row.id}
                  className={isSelected ? 'selected' : ''}
                  onClick={(e) => handleRowClick(virtualRow.index, e)}
                  style={{
                    height: `${virtualRow.size}px`,
                  }}
                >
                  {row.getVisibleCells().map((cell) => {
                    const isEditing =
                      editingCell?.rowIndex === virtualRow.index &&
                      editingCell?.columnId === cell.column.id;
                    const cellValue = cell.getValue();
                    const isNull = cellValue === null || cellValue === undefined;
                    const isPk = pkColumnSet.has(cell.column.id);

                    if (isEditing) {
                      return (
                        <td key={cell.id} className="editing">
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
                              if (e.key === 'Enter') { commitEdit(); }
                              if (e.key === 'Escape') { setEditingCell(null); }
                            }}
                          />
                        </td>
                      );
                    }

                    return (
                      <td
                        key={cell.id}
                        className={[
                          isNull ? 'null-value' : '',
                          isPk ? 'pk-column' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onDoubleClick={() =>
                          handleCellDoubleClick(virtualRow.index, cell.column.id)
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DataGridPagination page={page} onPageChange={handlePageChange} />
    </div>
  );
}
