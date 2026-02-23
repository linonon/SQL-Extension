import { useCallback, useEffect, useState } from 'react';

interface RedisHashEditorProps {
  readonly value: Record<string, string>;
  readonly onBatchEdit: (edits: ReadonlyArray<{ oldField: string; newField: string; value: string }>) => void;
  readonly onDeleteField: (field: string) => void;
  readonly hashDone: boolean;
  readonly onHashLoadMore: () => void;
}

export function RedisHashEditor({ value, onBatchEdit, onDeleteField, hashDone, onHashLoadMore }: RedisHashEditorProps) {
  const [newField, setNewField] = useState('');
  const [newValue, setNewValue] = useState('');
  // editMap: key = 原始 field name, value = { field: 当前 field, value: 当前 value }
  const [editMap, setEditMap] = useState<Record<string, { field: string; value: string }>>({});

  const [filterQuery, setFilterQuery] = useState('');

  // value prop 变化时重置编辑状态和 filter
  useEffect(() => {
    setEditMap({});
    setFilterQuery('');
  }, [value]);

  const entries = Object.entries(value);

  const filteredEntries = filterQuery.trim() === ''
    ? entries
    : entries.filter(([origField]) => {
        const q = filterQuery.toLowerCase();
        const edit = editMap[origField];
        const currentField = edit?.field ?? origField;
        const currentValue = edit?.value ?? value[origField];
        return currentField.toLowerCase().includes(q) || currentValue.toLowerCase().includes(q);
      });

  const handleFieldChange = useCallback((origField: string, newFieldName: string) => {
    setEditMap((prev) => {
      const current = prev[origField] ?? { field: origField, value: value[origField] };
      return { ...prev, [origField]: { ...current, field: newFieldName } };
    });
  }, [value]);

  const handleValueChange = useCallback((origField: string, newVal: string) => {
    setEditMap((prev) => {
      const current = prev[origField] ?? { field: origField, value: value[origField] };
      return { ...prev, [origField]: { ...current, value: newVal } };
    });
  }, [value]);

  const dirtyEntries = entries.filter(([origField]) => {
    const edit = editMap[origField];
    if (!edit) { return false; }
    return edit.field !== origField || edit.value !== value[origField];
  });
  const hasDirty = dirtyEntries.length > 0;

  const handleSaveAll = useCallback(() => {
    const edits: Array<{ oldField: string; newField: string; value: string }> = [];
    for (const [origField] of dirtyEntries) {
      const edit = editMap[origField];
      if (!edit) { continue; }
      edits.push({ oldField: origField, newField: edit.field, value: edit.value });
    }
    // newField 重复检测
    const newFields = edits.map((e) => e.newField);
    const dupes = newFields.filter((f, i) => newFields.indexOf(f) !== i);
    if (dupes.length > 0) {
      window.alert(`Duplicate field names: ${[...new Set(dupes)].join(', ')}`);
      return;
    }
    if (edits.length > 0) {
      onBatchEdit(edits);
    }
  }, [dirtyEntries, editMap, onBatchEdit]);

  const handleDiscard = useCallback(() => {
    setEditMap({});
  }, []);

  const handleAdd = useCallback(() => {
    const trimmedField = newField.trim();
    if (!trimmedField) { return; }
    onBatchEdit([{ oldField: trimmedField, newField: trimmedField, value: newValue }]);
    setNewField('');
    setNewValue('');
  }, [newField, newValue, onBatchEdit]);

  return (
    <div className="redis-hash-editor">
      <div className="hash-field-count">
        Showing {entries.length} fields{hashDone ? '' : ' (more available)'}
        {hasDirty && <span className="dirty-count"> ({dirtyEntries.length} modified)</span>}
      </div>
      <div className="hash-filter">
        <input
          type="text"
          placeholder="Filter fields..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
        {filterQuery && (
          <span className="filter-count">{filteredEntries.length} / {entries.length}</span>
        )}
      </div>
      {filteredEntries.map(([origField]) => {
        const edit = editMap[origField];
        const currentField = edit?.field ?? origField;
        const currentValue = edit?.value ?? value[origField];
        const isDirty = edit !== undefined && (edit.field !== origField || edit.value !== value[origField]);
        return (
          <div key={origField} className="hash-item">
            <input
              className={`field${isDirty ? ' editing-dirty' : ''}`}
              value={currentField}
              onChange={(e) => handleFieldChange(origField, e.target.value)}
            />
            <input
              className={`value${isDirty ? ' editing-dirty' : ''}`}
              value={currentValue}
              onChange={(e) => handleValueChange(origField, e.target.value)}
            />
            <button
              className="btn-icon"
              onClick={() => onDeleteField(origField)}
              title="Delete field"
            >
              x
            </button>
          </div>
        );
      })}
      {!hashDone && (
        <div className="redis-pagination">
          <button onClick={onHashLoadMore}>Load More</button>
        </div>
      )}
      {hasDirty && (
        <div className="batch-actions">
          <button onClick={handleSaveAll}>Save All ({dirtyEntries.length})</button>
          <button className="secondary" onClick={handleDiscard}>Discard</button>
        </div>
      )}
      <div className="add-form">
        <input
          placeholder="Field"
          value={newField}
          onChange={(e) => setNewField(e.target.value)}
        />
        <input
          placeholder="Value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button onClick={handleAdd} disabled={!newField.trim()}>
          Add Field
        </button>
      </div>
    </div>
  );
}
