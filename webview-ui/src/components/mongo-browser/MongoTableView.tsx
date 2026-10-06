import { useMemo, useState } from 'react';
import type { ColumnInfo } from '../../../../src/types/query';
import { buildDisplayColumns, getByPath } from './mongo-table-columns';
import { coerceToType, isEditableLeaf } from './mongo-field-editor';
import { idToShell } from './mongo-id';
import { localTime } from './mongo-leaf-type';
import { preview } from '../../utils/mongo-shell-to-json';

interface MongoTableViewProps {
  readonly columns: readonly ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  // 点 _id 单元格 (复合 _id 展开后为首个 _id.* 列) 打开该文档; 其余单元格的单击不做任何事, 双击留给原地编辑
  readonly onOpen?: (row: Record<string, unknown>) => void;
  // 单元格原地编辑提交: id 为行的 _id, path 为 dotted 字段路径, original 为编辑前的值, value 按原类型转换后的新值
  readonly onCellEdit?: (id: unknown, path: string, original: unknown, value: unknown) => void;
}

// 单元格显示文本: 子文档 / 数组是 shell 写法的预览
function cellText(value: unknown): string {
  return value === null || value === undefined ? '(null)' : preview(value);
}

// 单元格 title: 完整值截到 2KB (容器值可能有几百 KB), Date 附本地时间
function cellTitle(value: unknown): string {
  const local = localTime(value);
  return preview(value, 2048) + (local ? `\n${local}` : '');
}

const isIdPath = (path: string): boolean => path === '_id' || path.startsWith('_id.');

// 仅标量叶子可原地编辑, 且不在 _id 内 (_id 不可变, 改 _id 用 Clone). 可编辑性与类型转换复用 mongo-field-editor 的单一实现.
function isEditableCell(path: string, value: unknown): boolean {
  return !isIdPath(path) && isEditableLeaf(value);
}

export function MongoTableView({ columns, rows, onOpen, onCellEdit }: MongoTableViewProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<{ rowId: string; id: unknown; path: string; original: unknown } | null>(null);
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
  const openIdx = useMemo(() => displayCols.findIndex((c) => isIdPath(c.path)), [displayCols]);

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

  const startEdit = (rowId: string, id: unknown, path: string, value: unknown) => {
    setEditing({ rowId, id, path, original: value });
    setDraft(typeof value === 'object' ? '' : String(value));
  };
  const cancelEdit = () => setEditing(null);
  const commitEdit = () => {
    if (editing && onCellEdit) {
      const value = coerceToType(editing.original, draft);
      // 值没变 (含非法输入回退原值) 不发写请求
      if (value !== editing.original) { onCellEdit(editing.id, editing.path, editing.original, value); }
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
            <tr key={rowId || idx} className="mongo-document-row">
              {displayCols.map((col, colIdx) => {
                const v = getByPath(row, col.path);
                const editingThis = editing?.rowId === rowId && editing?.path === col.path;
                if (editingThis) {
                  return (
                    <td key={col.path}>
                      <input
                        className="mongo-cell-input"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                          else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                        }}
                        onBlur={commitEdit}
                      />
                    </td>
                  );
                }
                // rowId 为空 = _id 被投影排除, 无法定位文档 -> 不可原地编辑 (否则发 id='' 必然失败)
                const editable = onCellEdit != null && rowId !== '' && isEditableCell(col.path, v);
                const full = cellTitle(v);
                if (colIdx === openIdx && onOpen && rowId !== '') {
                  return (
                    <td key={col.path} title={`${full}\n(点击打开编辑)`}>
                      <button type="button" className="mongo-id-open" onClick={() => onOpen(row)}>{cellText(v)}</button>
                    </td>
                  );
                }
                return (
                  <td
                    key={col.path}
                    title={editable ? `${full}\n(双击编辑)` : full}
                    className={editable ? 'mongo-cell-editable' : undefined}
                    onDoubleClick={editable ? () => startEdit(rowId, row._id, col.path, v) : undefined}
                  >
                    {cellText(v)}
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
