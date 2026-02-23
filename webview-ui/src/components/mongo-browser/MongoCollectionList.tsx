import { useCallback, useMemo, useState } from 'react';
import type { GlobalCollectionInfo } from './MongoBrowser';

interface SelectedCollection {
  readonly database: string;
  readonly name: string;
}

interface MongoCollectionListProps {
  readonly collections: readonly GlobalCollectionInfo[];
  readonly selected: SelectedCollection | null;
  readonly loading?: boolean;
  readonly onSelectCollection: (database: string, name: string) => void;
  readonly onCreateCollection: (database: string) => void;
  readonly onDropCollection: (database: string, collection: string) => void;
}

function formatCount(n: number): string {
  if (n >= 1000000) { return `${(n / 1000000).toFixed(1)}M`; }
  if (n >= 1000) { return `${(n / 1000).toFixed(1)}k`; }
  return String(n);
}

export function MongoCollectionList({ collections, selected, loading, onSelectCollection, onCreateCollection, onDropCollection }: MongoCollectionListProps) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    if (!filter) { return collections; }
    const lower = filter.toLowerCase();
    return collections.filter((c) => c.name.toLowerCase().includes(lower));
  }, [collections, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, GlobalCollectionInfo[]>();
    for (const c of filtered) {
      const list = map.get(c.database);
      if (list) {
        list.push(c);
      } else {
        map.set(c.database, [c]);
      }
    }
    return map;
  }, [filtered]);

  const handleFilterChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFilter(e.target.value);
  }, []);

  const isSelected = (db: string, name: string) =>
    selected !== null && selected.database === db && selected.name === name;

  return (
    <div className="mongo-collection-list-panel">
      <div className="mongo-filter-bar">
        <input
          type="text"
          value={filter}
          onChange={handleFilterChange}
          placeholder="Filter collections..."
        />
      </div>
      <div className="mongo-collection-list">
        {loading ? (
          <div className="mongo-spinner-wrap">
            <div className="mongo-spinner" />
            <span>Loading collections...</span>
          </div>
        ) : (
          <>
            {Array.from(grouped.entries()).map(([database, cols]) => (
              <div key={database} className="mongo-db-group">
                <div className="mongo-db-header">
                  <span className="mongo-db-name">{database}</span>
                  <button
                    className="mongo-db-action-btn"
                    title={`Create collection in ${database}`}
                    onClick={(e) => { e.stopPropagation(); onCreateCollection(database); }}
                  >+</button>
                </div>
                {cols.map((c) => (
                  <div
                    key={`${database}.${c.name}`}
                    className={`mongo-collection-item${isSelected(database, c.name) ? ' selected' : ''}`}
                    onClick={() => onSelectCollection(database, c.name)}
                  >
                    <span className="collection-name">{c.name}</span>
                    <span className="collection-count">{formatCount(c.count)}</span>
                    <button
                      className="mongo-collection-drop-btn"
                      title={`Drop ${c.name}`}
                      onClick={(e) => { e.stopPropagation(); onDropCollection(database, c.name); }}
                    >{'\u{1F5D1}'}</button>
                  </div>
                ))}
              </div>
            ))}
            {grouped.size === 0 && (
              <div className="mongo-empty">No collections found</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
