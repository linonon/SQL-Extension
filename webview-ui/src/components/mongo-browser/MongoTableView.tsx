import type { ColumnInfo } from '../../types/database';

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
  return (
    <table className="mongo-table">
      <thead>
        <tr>{columns.map((col) => <th key={col.name} title={col.dataType}>{col.name}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => (
          <tr key={String(row._id ?? idx)} className="mongo-document-row" onClick={() => onRowClick(row)}>
            {columns.map((col) => {
              const v = row[col.name];
              const full = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
              return <td key={col.name} title={full}>{cellText(v, 80)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
