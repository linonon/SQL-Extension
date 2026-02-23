import { useCallback, useEffect, useState } from 'react';

interface RedisSetEditorProps {
  readonly members: readonly string[];
  readonly hasMore: boolean;
  readonly onAdd: (member: string) => void;
  readonly onRemove: (member: string) => void;
  readonly onBatchEdit: (edits: ReadonlyArray<{ oldMember: string; newMember: string }>) => void;
  readonly onLoadMore: () => void;
}

export function RedisSetEditor({
  members,
  hasMore,
  onAdd,
  onRemove,
  onBatchEdit,
  onLoadMore,
}: RedisSetEditorProps) {
  const [newMember, setNewMember] = useState('');
  // editMap: original member -> current edited value (只追踪被修改过的 member)
  const [editMap, setEditMap] = useState<Record<string, string>>({});

  // members prop 变化时 (save 后 re-fetch) 清除编辑状态
  useEffect(() => {
    setEditMap({});
  }, [members]);

  const handleAdd = useCallback(() => {
    const trimmed = newMember.trim();
    if (!trimmed) { return; }
    onAdd(trimmed);
    setNewMember('');
  }, [newMember, onAdd]);

  const handleAddKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { handleAdd(); }
  }, [handleAdd]);

  const handleEditChange = useCallback((member: string, val: string) => {
    setEditMap((prev) => {
      if (val === member) {
        const next = { ...prev };
        delete next[member];
        return next;
      }
      return { ...prev, [member]: val };
    });
  }, []);

  const dirtyEdits = Object.entries(editMap)
    .filter(([orig, edited]) => edited.trim() !== '' && edited.trim() !== orig)
    .map(([orig, edited]) => ({ oldMember: orig, newMember: edited.trim() }));
  const hasDirty = dirtyEdits.length > 0;

  const handleSaveAll = useCallback(() => {
    if (dirtyEdits.length > 0) {
      onBatchEdit(dirtyEdits);
    }
  }, [dirtyEdits, onBatchEdit]);

  const handleDiscardAll = useCallback(() => {
    setEditMap({});
  }, []);

  return (
    <div className="redis-set-editor">
      {members.map((member) => {
        const currentValue = editMap[member] ?? member;
        const isDirty = member in editMap && editMap[member].trim() !== member;
        return (
          <div key={member} className="set-item">
            <input
              className={`value${isDirty ? ' editing-dirty' : ''}`}
              value={currentValue}
              onChange={(e) => handleEditChange(member, e.target.value)}
            />
            <button
              className="btn-icon"
              onClick={() => onRemove(member)}
              title="Remove member"
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
          <button onClick={handleSaveAll}>Save All ({dirtyEdits.length})</button>
          <button className="secondary" onClick={handleDiscardAll}>Discard</button>
        </div>
      )}
      <div className="add-form">
        <input
          placeholder="Member"
          value={newMember}
          onChange={(e) => setNewMember(e.target.value)}
          onKeyDown={handleAddKeyDown}
        />
        <button onClick={handleAdd} disabled={!newMember.trim()}>
          Add Member
        </button>
      </div>
    </div>
  );
}
