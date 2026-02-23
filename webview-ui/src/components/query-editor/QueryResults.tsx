import type { ColumnInfo } from '../../types/database';

interface QueryResultsProps {
  readonly columns: ColumnInfo[];
  readonly rows: Record<string, unknown>[];
  readonly affectedRows: number;
  readonly executionTime: number;
  readonly error?: string;
}

export function QueryResults({
  columns,
  rows,
  affectedRows,
  executionTime,
  error,
}: QueryResultsProps) {
  if (error) {
    return <div className="query-results-error">{error}</div>;
  }

  const hasRows = columns.length > 0 && rows.length > 0;

  return (
    <div className="query-results">
      <div className="query-results-info">
        {hasRows
          ? `${rows.length} rows returned in ${executionTime}ms`
          : `${affectedRows} rows affected in ${executionTime}ms`}
      </div>
      {hasRows && (
        <div className="query-results-table">
          <table className="data-grid-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.name}>{col.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {columns.map((col) => {
                    const value = row[col.name];
                    const isNull = value === null || value === undefined;
                    return (
                      <td key={col.name} className={isNull ? 'null-value' : ''}>
                        {isNull ? 'NULL' : String(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
