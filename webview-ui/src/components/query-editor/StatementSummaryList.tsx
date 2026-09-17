import type { StatementResult } from '../../types/messages';

interface StatementSummaryListProps {
  readonly statements: readonly StatementResult[];
}

function truncate(sql: string, max: number): string {
  return sql.length <= max ? sql : `${sql.slice(0, max)}...`;
}

export function StatementSummaryList({ statements }: StatementSummaryListProps) {
  return (
    <div className="statement-summary-list">
      {statements.map((s) => (
        <div key={s.index} className={`statement-summary-row status-${s.status}`}>
          <div className="statement-summary-meta">
            <span className="statement-summary-status">
              {s.index}{' '}
              {s.status === 'ok' ? 'OK' : s.status === 'error' ? 'ERR' : 'skipped'}
            </span>
            {s.status === 'ok' && (
              <span className="statement-summary-stats">
                {s.executionTime ?? 0}ms · affected {s.affectedRows ?? 0}
              </span>
            )}
          </div>
          <div className="statement-summary-sql">{truncate(s.sql, 120)}</div>
          {s.status === 'error' && s.error ? (
            <div className="statement-summary-error">{s.error}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
