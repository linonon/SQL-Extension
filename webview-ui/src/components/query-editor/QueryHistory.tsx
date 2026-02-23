import { useCallback, useState } from 'react';
import vscodeApi from '../../vscode';

const MAX_HISTORY = 50;
const STATE_KEY = 'queryHistory';

export interface HistoryEntry {
  readonly sql: string;
  readonly executionTime: number;
  readonly timestamp: number;
}

function loadHistory(): readonly HistoryEntry[] {
  const state = vscodeApi.getState() as Record<string, unknown> | undefined;
  return (state?.[STATE_KEY] as HistoryEntry[] | undefined) ?? [];
}

function saveHistory(entries: readonly HistoryEntry[]): void {
  const state = (vscodeApi.getState() as Record<string, unknown> | undefined) ?? {};
  vscodeApi.setState({ ...state, [STATE_KEY]: entries });
}

export function useQueryHistory() {
  const [entries, setEntries] = useState<readonly HistoryEntry[]>(loadHistory);

  const addEntry = useCallback((sql: string, executionTime: number) => {
    setEntries((prev) => {
      const next = [
        { sql, executionTime, timestamp: Date.now() },
        ...prev.filter((e) => e.sql !== sql),
      ].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, []);

  return { entries, addEntry } as const;
}

interface QueryHistoryProps {
  readonly entries: readonly HistoryEntry[];
  readonly onSelect: (sql: string) => void;
}

export function QueryHistory({ entries, onSelect }: QueryHistoryProps) {
  if (entries.length === 0) {
    return <div className="query-history-empty">No history yet</div>;
  }

  return (
    <div className="query-history-list">
      {entries.map((entry) => (
        <button
          key={entry.timestamp}
          className="query-history-item"
          onClick={() => onSelect(entry.sql)}
          title={entry.sql}
        >
          <span className="query-history-sql">{entry.sql}</span>
          <span className="query-history-meta">
            {entry.executionTime}ms | {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
        </button>
      ))}
    </div>
  );
}
