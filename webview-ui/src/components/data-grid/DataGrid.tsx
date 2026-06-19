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
import { buildInsertRow } from '../../utils/insert-row';
import { validateCellValue } from '../../utils/cell-value-validator';
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
  // 写操作 (insert/update/delete) 失败的非致命错误: 行内提示, 不替换整个网格
  const [writeError, setWriteError] = useState<string | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  // 给 message handler 读取当前 offset 而不必把 handler 依赖到 page 上 (避免每翻页重订阅)
  const pageOffsetRef = useRef(page.offset);
  pageOffsetRef.current = page.offset;

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
        // 写操作回执: 成功才刷新 (消除写入与刷新的竞态), 失败行内提示且保留网格
        case 'updateRowResult':
        case 'insertRowResult':
        case 'deleteRowsResult':
          if (message.success) {
            setWriteError(null);
            fetchData(pageOffsetRef.current);
          } else if (message.type !== 'deleteRowsResult' || !message.cancelled) {
            setWriteError(message.error ?? '操作失败');
          }
          break;
      }
    },
    [fetchData]
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

    // 提交前值校验: 拦非数字写进数字列 / 非法日期写进日期列 等静默写错值
    const editedCol = columns.find((c) => c.name === editingCell.columnId);
    if (editedCol) {
      const problem = validateCellValue(editedCol, newValue);
      if (problem) {
        setWriteError(problem);
        setEditingCell(null);
        return;
      }
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
    // 不立即刷新: 等 updateRowResult 成功回执再刷新, 避免 SELECT 早于 UPDATE 提交读到旧值
  }, [editingCell, rows, columns, database, table, postMessage]);

  const handleInsert = useCallback(() => {
    // 自增/序列/表达式默认值列省略, 交给 DB 应用默认; 不把 defaultValue 文本当字面值写库
    const newRow = buildInsertRow(columns);
    postMessage({ type: 'insertRow', database, table, row: newRow });
    // 刷新由 insertRowResult 成功回执驱动 (不用定时器猜写入是否完成)
  }, [columns, database, table, postMessage]);

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
      // 刷新由 deleteRowsResult 成功回执驱动
    }
  }, [columns, selectedRows, rows, database, table, postMessage]);

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
      {writeError && (
        <div className="data-grid-write-error">
          <span>{writeError}</span>
          <button title="Dismiss" onClick={() => setWriteError(null)}>×</button>
        </div>
      )}
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
