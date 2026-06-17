import { useMemo, useState } from 'react';
import type { ColumnInfo } from '../../types/database';
import { buildDisplayColumns, getByPath } from './mongo-table-columns';

interface MongoTableViewProps {
  readonly columns: readonly ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  readonly onRowClick: (row: Record<string, unknown>) => void;
}

// 将 cell 值转换为显示字符串, 对象类型 JSON.stringify 以避免 [object Object]
function cellText(value: unknown, max: number): string {
  if (value === null || value === undefined) { return '(null)'; }
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

export function MongoTableView({ columns, rows, onRowClick }: MongoTableViewProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

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
      // 移除该 path 及其所有后代, 防止残留导致重新展开
      for (const p of prev) {
        if (p === path || p.startsWith(`${path}.`)) { next.delete(p); }
      }
      return next;
    });

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
        {rows.map((row, idx) => (
          <tr key={String(row._id ?? idx)} className="mongo-document-row" onClick={() => onRowClick(row)}>
            {displayCols.map((col) => {
              const v = getByPath(row, col.path);
              const full = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
              return <td key={col.path} title={full}>{cellText(v, 80)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
