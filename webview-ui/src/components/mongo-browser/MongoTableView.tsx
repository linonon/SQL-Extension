import { useMemo, useState } from 'react';
import type { ColumnInfo } from '../../types/database';
import { buildDisplayColumns, getByPath } from './mongo-table-columns';
import { coerceToType, isEditableLeaf } from './mongo-field-editor';
import { idToShell } from './mongo-id';

interface MongoTableViewProps {
  readonly columns: readonly ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  readonly onRowClick: (row: Record<string, unknown>) => void;
  // 单元格原地编辑提交: id 为 _id 的 shell 形式, path 为 dotted 字段路径, value 保留原类型
  readonly onCellEdit?: (id: string, path: string, value: unknown) => void;
}

// 将 cell 值转换为显示字符串, 对象类型 JSON.stringify 以避免 [object Object]
function cellText(value: unknown, max: number): string {
  if (value === null || value === undefined) { return '(null)'; }
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// 仅标量叶子可原地编辑, 且非 _id (改 _id 用 Clone). 可编辑性与类型转换复用 mongo-field-editor 的单一实现.
function isEditableCell(path: string, value: unknown): boolean {
  return path !== '_id' && isEditableLeaf(value);
}

export function MongoTableView({ columns, rows, onRowClick, onCellEdit }: MongoTableViewProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<{ rowId: string; path: string; original: unknown } | null>(null);
  const [draft, setDraft] = useState('');

  const topLevel = useMemo(() => columns.map((c) => c.name), [columns]);
  const displayCols = useMemo(
    () => buildDisplayColumns(topLevel, rows, expanded),
    [topLevel, rows, expanded],
  );

  // 每个展开组只在首个子列显示一次折叠按钮, 避免多子字段时重复 ⊖
  const firstCollapseIdx = useMemo(() => {
    const m = new Map<string, number>();
    displayCols.forEach((c, i) => {
      if (c.collapseParent && !m.has(c.collapseParent)) { m.set(c.collapseParent, i); }
    });
    return m;
  }, [displayCols]);

  const expand = (path: string) =>
    setExpanded((prev) => new Set(prev).add(path));
  const collapse = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of prev) {
        if (p === path || p.startsWith(`${path}.`)) { next.delete(p); }
      }
      return next;
    });

  const startEdit = (rowId: string, path: string, value: unknown) => {
    setEditing({ rowId, path, original: value });
    setDraft(typeof value === 'object' ? '' : String(value));
  };
  const cancelEdit = () => setEditing(null);
  const commitEdit = () => {
    if (editing && onCellEdit) {
      onCellEdit(editing.rowId, editing.path, coerceToType(editing.original, draft));
    }
    setEditing(null);
  };

  return (
    <table className="mongo-table">
      <thead>
        <tr>
          {displayCols.map((col, idx) => (
            <th key={col.path} title={col.path}>
              <span className="mongo-th-label">{col.label}</span>
              {col.collapseParent && firstCollapseIdx.get(col.collapseParent) === idx && (
                <button
                  className="mongo-th-toggle"
                  aria-label={`Collapse ${col.collapseParent}`}
                  title={`Collapse ${col.collapseParent}`}
                  onClick={() => collapse(col.collapseParent!)}
                >
                  ⊖
                </button>
              )}
              {col.expandable && (
                <button
                  className="mongo-th-toggle"
                  aria-label={`Expand ${col.path}`}
                  title={`Expand embedded fields of ${col.path}`}
                  onClick={() => expand(col.path)}
                >
                  ⊕
                </button>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => {
          const rowId = idToShell(row._id);
          return (
            <tr key={String(row._id ?? idx)} className="mongo-document-row" onClick={() => onRowClick(row)}>
              {displayCols.map((col) => {
                const v = getByPath(row, col.path);
                const editingThis = editing?.rowId === rowId && editing?.path === col.path;
                if (editingThis) {
                  return (
                    <td key={col.path} onClick={(e) => e.stopPropagation()}>
                      <input
                        className="mongo-cell-input"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                          else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                        }}
                        onBlur={cancelEdit}
                      />
                    </td>
                  );
                }
                const editable = onCellEdit != null && isEditableCell(col.path, v);
                const full = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
                return (
                  <td
                    key={col.path}
                    title={editable ? `${full}\n(双击编辑)` : full}
                    className={editable ? 'mongo-cell-editable' : undefined}
                    onDoubleClick={editable ? (e) => { e.stopPropagation(); startEdit(rowId, col.path, v); } : undefined}
                  >
                    {cellText(v, 80)}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
