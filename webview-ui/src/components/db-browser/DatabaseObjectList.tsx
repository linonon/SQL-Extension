import { useCallback, useMemo, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu';
import { fuzzyScore } from '../../utils/fuzzy-score';

export interface DatabaseInfo {
  readonly name: string;
  readonly tables: readonly TableInfo[];
}

export interface TableInfo {
  readonly name: string;
  readonly rowCount: number;
}

interface SelectedTable {
  readonly database: string;
  readonly table: string;
}

interface DatabaseObjectListProps {
  readonly databases: readonly DatabaseInfo[];
  readonly selected: SelectedTable | null;
  readonly loading?: boolean;
  readonly onSelectTable: (database: string, table: string) => void;
  readonly onNewQuery: (database: string) => void;
  readonly onImportSql: (database: string, table?: string) => void;
  readonly onEditTable: (database: string, table: string) => void;
  readonly onShowDDL: (database: string, table: string) => void;
  readonly onDumpStruct: (database: string, table: string) => void;
  readonly onDumpStructAndData: (database: string, table: string) => void;
}

function formatRowCount(n: number): string {
  if (n >= 1000000) { return `${(n / 1000000).toFixed(1)}M`; }
  if (n >= 1000) { return `${(n / 1000).toFixed(1)}k`; }
  return String(n);
}

interface ScoredDatabase {
  readonly db: DatabaseInfo;
  readonly score: number;
  readonly tables: readonly TableInfo[];
}

function filterDatabases(
  databases: readonly DatabaseInfo[],
  filterText: string
): readonly DatabaseInfo[] {
  if (!filterText) { return databases; }
  const dotIdx = filterText.indexOf('.');
  if (dotIdx >= 0) {
    // db.table 格式: dot 前 fuzzy 匹配 db name, dot 后 fuzzy 匹配 table name
    const dbPattern = filterText.slice(0, dotIdx);
    const tablePattern = filterText.slice(dotIdx + 1);
    return databases
      .filter((d) => !dbPattern || fuzzyScore(dbPattern, d.name) > 0)
      .map((d) => ({
        ...d,
        tables: !tablePattern
          ? d.tables
          : d.tables.filter((t) => fuzzyScore(tablePattern, t.name) > 0),
      }))
      .filter((d) => d.tables.length > 0);
  }
  // 单关键字: fuzzy 匹配 db name 或 table name, 按最高分排序
  const scored: ScoredDatabase[] = [];
  for (const d of databases) {
    const dbScore = fuzzyScore(filterText, d.name);
    const matchedTables = d.tables
      .map((t) => ({ table: t, score: fuzzyScore(filterText, t.name) }))
      .filter((r) => r.score > 0);
    if (dbScore > 0) {
      // db name 匹配: 保留所有 tables
      scored.push({ db: d, score: dbScore, tables: d.tables });
    } else if (matchedTables.length > 0) {
      // table name 匹配: 只保留匹配的 tables, 取最高 table score
      const bestScore = Math.max(...matchedTables.map((r) => r.score));
      scored.push({ db: d, score: bestScore, tables: matchedTables.map((r) => r.table) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => ({ ...s.db, tables: s.tables }));
}

export function DatabaseObjectList({
  databases,
  selected,
  loading,
  onSelectTable,
  onNewQuery,
  onImportSql,
  onEditTable,
  onShowDDL,
  onDumpStruct,
  onDumpStructAndData,
}: DatabaseObjectListProps) {
  const [filter, setFilter] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    items: ContextMenuItem[];
    position: { x: number; y: number };
  } | null>(null);

  const filtered = useMemo(() => filterDatabases(databases, filter), [databases, filter]);

  const isSelected = (db: string, table: string) =>
    selected !== null && selected.database === db && selected.table === table;

  const handleDbContextMenu = useCallback((e: React.MouseEvent, database: string) => {
    e.preventDefault();
    setContextMenu({
      items: [
        { label: 'New Query', action: () => onNewQuery(database) },
        { label: 'Import SQL', action: () => onImportSql(database) },
      ],
      position: { x: e.clientX, y: e.clientY },
    });
  }, [onNewQuery, onImportSql]);

  const handleTableContextMenu = useCallback((e: React.MouseEvent, database: string, table: string) => {
    e.preventDefault();
    setContextMenu({
      items: [
        { label: 'Open Table', action: () => onSelectTable(database, table) },
        { label: 'Edit Table', action: () => onEditTable(database, table) },
        { label: 'Show DDL', action: () => onShowDDL(database, table) },
        { label: 'Dump Struct', action: () => onDumpStruct(database, table) },
        { label: 'Dump Struct and Data', action: () => onDumpStructAndData(database, table) },
        { label: 'Import SQL', action: () => onImportSql(database, table) },
      ],
      position: { x: e.clientX, y: e.clientY },
    });
  }, [onSelectTable, onEditTable, onShowDDL, onDumpStruct, onDumpStructAndData, onImportSql]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <div className="db-object-list-panel">
      <div className="db-filter-bar">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter db or table... (db.table)"
        />
      </div>
      <div className="db-object-list">
        {loading ? (
          <div className="db-spinner-wrap">
            <div className="db-spinner" />
            <span>Loading...</span>
          </div>
        ) : (
          <>
            {filtered.map((db) => (
              <div key={db.name} className="db-group">
                <div
                  className="db-group-header"
                  onContextMenu={(e) => handleDbContextMenu(e, db.name)}
                >
                  <span className="db-group-name">{db.name}</span>
                  <span className="db-group-count">{db.tables.length}</span>
                </div>
                {db.tables.map((t) => (
                  <div
                    key={`${db.name}.${t.name}`}
                    className={`db-table-item${isSelected(db.name, t.name) ? ' selected' : ''}`}
                    onClick={() => onSelectTable(db.name, t.name)}
                    onContextMenu={(e) => handleTableContextMenu(e, db.name, t.name)}
                  >
                    <span className="db-table-name">{t.name}</span>
                    <span className="db-table-count">{formatRowCount(t.rowCount)}</span>
                  </div>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="db-empty">No tables found</div>
            )}
          </>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
