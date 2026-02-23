import { useCallback, useEffect, useState } from 'react';

interface RedisListEditorProps {
  readonly value: readonly string[];
  readonly total: number;
  readonly onPush: (value: string, position: 'head' | 'tail') => void;
  readonly onRemove: (index: number) => void;
  readonly onBatchSet: (entries: ReadonlyArray<{ readonly index: number; readonly value: string }>) => void;
  readonly onLoadMore: () => void;
  readonly hasMore: boolean;
}

export function RedisListEditor({
  value,
  total,
  onPush,
  onRemove,
  onBatchSet,
  onLoadMore,
  hasMore,
}: RedisListEditorProps) {
  const [newValue, setNewValue] = useState('');
  // editMap: index -> edited value (只追踪被修改过的 item)
  const [editMap, setEditMap] = useState<Record<number, string>>({});

  // value prop 变化时 (save/delete 后 re-fetch) 清除编辑状态
  useEffect(() => {
    setEditMap({});
  }, [value]);

  const handlePush = useCallback((position: 'head' | 'tail') => {
    if (!newValue.trim()) { return; }
    onPush(newValue, position);
    setNewValue('');
  }, [newValue, onPush]);

  const handleEditChange = useCallback((index: number, original: string, val: string) => {
    setEditMap((prev) => {
      if (val === original) {
        const next = { ...prev };
        delete next[index];
        return next;
      }
      return { ...prev, [index]: val };
    });
  }, []);

  const dirtyEntries = Object.entries(editMap)
    .filter(([, edited]) => edited !== undefined)
    .map(([idx, edited]) => ({ index: Number(idx), value: edited }))
    .filter((entry) => entry.value !== value[entry.index]);
  const hasDirty = dirtyEntries.length > 0;

  const handleSaveAll = useCallback(() => {
    if (dirtyEntries.length > 0) {
      onBatchSet(dirtyEntries);
    }
  }, [dirtyEntries, onBatchSet]);

  const handleDiscardAll = useCallback(() => {
    setEditMap({});
  }, []);

  return (
    <div className="redis-list-editor">
      <div className="redis-pagination">
        Showing {value.length} of {total} items
      </div>
      {value.map((item, index) => {
        const currentValue = editMap[index] ?? item;
        const isDirty = index in editMap && editMap[index] !== item;
        return (
          <div key={index} className="list-item">
            <span className="index">[{index}]</span>
            <input
              className={`value${isDirty ? ' editing-dirty' : ''}`}
              value={currentValue}
              onChange={(e) => handleEditChange(index, item, e.target.value)}
            />
            <button
              className="btn-icon"
              onClick={() => onRemove(index)}
              title="Remove item"
            >
              x
            </button>
          </div>
        );
      })}
      {hasMore && (
        <div className="redis-load-more">
          <button className="secondary" onClick={onLoadMore}>
            Load More
          </button>
        </div>
      )}
      {hasDirty && (
        <div className="batch-actions">
          <button onClick={handleSaveAll}>Save All ({dirtyEntries.length})</button>
          <button className="secondary" onClick={handleDiscardAll}>Discard</button>
        </div>
      )}
      <div className="add-form">
        <input
          placeholder="Value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button
          className="secondary"
          onClick={() => handlePush('head')}
          disabled={!newValue.trim()}
        >
          Push Head
        </button>
        <button
          onClick={() => handlePush('tail')}
          disabled={!newValue.trim()}
        >
          Push Tail
        </button>
      </div>
    </div>
  );
}
