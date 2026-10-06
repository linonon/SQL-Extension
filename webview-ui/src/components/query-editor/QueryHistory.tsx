import { useCallback, useEffect, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage, QueryHistoryEntry } from '../../types/messages';

interface QueryHistoryProps {
  readonly onSelect: (sql: string) => void;
}

// 本连接的查询历史 (宿主按连接存在 globalState, 跨会话保留): 打开时向宿主要一次, 按 SQL / 库名过滤
export function QueryHistory({ onSelect }: QueryHistoryProps) {
  const postMessage = usePostMessage();
  const [entries, setEntries] = useState<readonly QueryHistoryEntry[] | null>(null);
  const [filter, setFilter] = useState('');

  useVSCodeMessage(useCallback((message: ExtensionMessage) => {
    if (message.type === 'queryHistory') setEntries(message.entries);
  }, []));

  useEffect(() => {
    postMessage({ type: 'listQueryHistory' });
  }, [postMessage]);

  const q = filter.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => !q || e.sql.toLowerCase().includes(q) || e.database.toLowerCase().includes(q));

  return (
    <div className="query-history-list">
      <input
        className="query-history-filter"
        type="text"
        placeholder="Filter history..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {entries === null ? (
        <div className="query-history-empty">Loading...</div>
      ) : shown.length === 0 ? (
        <div className="query-history-empty">{entries.length === 0 ? 'No history yet' : 'No match'}</div>
      ) : (
        shown.map((entry, i) => (
          <button
            key={`${entry.ts}-${i}`}
            className="query-history-item"
            onClick={() => onSelect(entry.sql)}
            title={entry.sql}
          >
            <span className="query-history-sql">{entry.sql}</span>
            <span className={`query-history-meta${entry.ok ? '' : ' failed'}`}>
              {entry.ok ? '' : 'failed | '}{entry.database} | {new Date(entry.ts).toLocaleString()}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
