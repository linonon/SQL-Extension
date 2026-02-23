import { useCallback, useRef, useState } from 'react';
import type { ColumnInfo } from '../types/database';

interface PendingChange {
  readonly rowIndex: number;
  readonly columnId: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

interface BatchUpdate {
  readonly primaryKeys: Record<string, unknown>;
  readonly changes: Record<string, unknown>;
}

function cellKey(rowIndex: number, columnId: string): string {
  return `${rowIndex}:${columnId}`;
}

export function useBatchEdits() {
  const [version, setVersion] = useState(0);
  const changesRef = useRef<Map<string, PendingChange>>(new Map());

  const addChange = useCallback(
    (rowIndex: number, columnId: string, oldValue: unknown, newValue: unknown) => {
      const key = cellKey(rowIndex, columnId);
      // 改回原值时移除 pending change
      if (String(oldValue ?? '') === String(newValue ?? '')) {
        changesRef.current.delete(key);
      } else {
        changesRef.current.set(key, { rowIndex, columnId, oldValue, newValue });
      }
      setVersion((v) => v + 1);
    },
    []
  );

  const isCellChanged = useCallback(
    (rowIndex: number, columnId: string): boolean => {
      // version 用于触发 re-render, 这里读一下避免被 tree-shake
      void version;
      return changesRef.current.has(cellKey(rowIndex, columnId));
    },
    [version]
  );

  const getCellValue = useCallback(
    (rowIndex: number, columnId: string, originalValue: unknown): unknown => {
      void version;
      const change = changesRef.current.get(cellKey(rowIndex, columnId));
      return change ? change.newValue : originalValue;
    },
    [version]
  );

  const buildUpdates = useCallback(
    (rows: Record<string, unknown>[], columns: ColumnInfo[]): BatchUpdate[] => {
      const pkColumns = columns.filter((c) => c.isPrimaryKey);
      if (pkColumns.length === 0) return [];

      // 按 rowIndex 聚合 changes
      const byRow = new Map<number, Record<string, unknown>>();
      for (const change of changesRef.current.values()) {
        let rowChanges = byRow.get(change.rowIndex);
        if (!rowChanges) {
          rowChanges = {};
          byRow.set(change.rowIndex, rowChanges);
        }
        rowChanges[change.columnId] = change.newValue;
      }

      const updates: BatchUpdate[] = [];
      for (const [rowIndex, changes] of byRow) {
        const row = rows[rowIndex];
        if (!row) continue;
        const primaryKeys: Record<string, unknown> = {};
        for (const pk of pkColumns) {
          primaryKeys[pk.name] = row[pk.name];
        }
        updates.push({ primaryKeys, changes });
      }
      return updates;
    },
    []
  );

  const clearChanges = useCallback(() => {
    changesRef.current.clear();
    setVersion((v) => v + 1);
  }, []);

  const pendingCount = changesRef.current.size;

  return { addChange, isCellChanged, getCellValue, buildUpdates, clearChanges, pendingCount };
}
