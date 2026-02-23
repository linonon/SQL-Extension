import { useCallback, useEffect, useState } from 'react';

interface ZSetEntry {
  readonly member: string;
  readonly score: number;
}

interface RedisSortedSetEditorProps {
  readonly entries: readonly ZSetEntry[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly onAdd: (member: string, score: number) => void;
  readonly onRemove: (member: string) => void;
  readonly onBatchEdit: (edits: ReadonlyArray<{ oldMember: string; newMember: string; score: number }>) => void;
  readonly onLoadMore: () => void;
}

export function RedisSortedSetEditor({
  entries,
  total,
  hasMore,
  onAdd,
  onRemove,
  onBatchEdit,
  onLoadMore,
}: RedisSortedSetEditorProps) {
  const [newMember, setNewMember] = useState('');
  const [newScore, setNewScore] = useState('0');
  // editMap: key = 原始 member, value = { member: 当前 member, score: 当前 score (string 允许中间状态) }
  const [editMap, setEditMap] = useState<Record<string, { member: string; score: string }>>({});

  // entries prop 变化时重置编辑状态
  useEffect(() => {
    setEditMap({});
  }, [entries]);

  const handleMemberChange = useCallback((origMember: string, origScore: number, newMemberVal: string) => {
    setEditMap((prev) => {
      const current = prev[origMember] ?? { member: origMember, score: String(origScore) };
      return { ...prev, [origMember]: { ...current, member: newMemberVal } };
    });
  }, []);

  const handleScoreChange = useCallback((origMember: string, origScore: number, newScoreVal: string) => {
    setEditMap((prev) => {
      const current = prev[origMember] ?? { member: origMember, score: String(origScore) };
      return { ...prev, [origMember]: { ...current, score: newScoreVal } };
    });
  }, []);

  const dirtyEntries = entries.filter((entry) => {
    const edit = editMap[entry.member];
    if (!edit) { return false; }
    const parsedScore = Number(edit.score);
    if (!Number.isFinite(parsedScore)) { return false; }
    return edit.member !== entry.member || parsedScore !== entry.score;
  });
  const hasDirty = dirtyEntries.length > 0;

  const handleSaveAll = useCallback(() => {
    const edits: Array<{ oldMember: string; newMember: string; score: number }> = [];
    for (const entry of dirtyEntries) {
      const edit = editMap[entry.member];
      if (!edit) { continue; }
      const parsedScore = Number(edit.score);
      if (!Number.isFinite(parsedScore)) { continue; }
      edits.push({ oldMember: entry.member, newMember: edit.member, score: parsedScore });
    }
    if (edits.length > 0) {
      onBatchEdit(edits);
    }
  }, [dirtyEntries, editMap, onBatchEdit]);

  const handleDiscardAll = useCallback(() => {
    setEditMap({});
  }, []);

  const handleAdd = useCallback(() => {
    if (!newMember.trim()) { return; }
    onAdd(newMember.trim(), Number(newScore));
    setNewMember('');
    setNewScore('0');
  }, [newMember, newScore, onAdd]);

  return (
    <div className="redis-zset-editor">
      <div className="redis-pagination">
        Showing {entries.length} of {total} items
        {hasDirty && <span className="dirty-count"> ({dirtyEntries.length} modified)</span>}
      </div>
      {entries.map((entry) => {
        const edit = editMap[entry.member];
        const currentMember = edit?.member ?? entry.member;
        const currentScore = edit?.score ?? String(entry.score);
        const parsedScore = Number(currentScore);
        const isDirty = edit !== undefined && Number.isFinite(parsedScore) &&
          (edit.member !== entry.member || parsedScore !== entry.score);
        return (
          <div key={entry.member} className="zset-item">
            <input
              type="number"
              className={`score${isDirty ? ' editing-dirty' : ''}`}
              value={currentScore}
              onChange={(e) => handleScoreChange(entry.member, entry.score, e.target.value)}
            />
            <input
              className={`member${isDirty ? ' editing-dirty' : ''}`}
              value={currentMember}
              onChange={(e) => handleMemberChange(entry.member, entry.score, e.target.value)}
            />
            <button
              className="btn-icon"
              onClick={() => onRemove(entry.member)}
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
          <button onClick={handleSaveAll}>Save All ({dirtyEntries.length})</button>
          <button className="secondary" onClick={handleDiscardAll}>Discard</button>
        </div>
      )}
      <div className="add-form">
        <input
          placeholder="Member"
          value={newMember}
          onChange={(e) => setNewMember(e.target.value)}
        />
        <input
          type="number"
          placeholder="Score"
          value={newScore}
          onChange={(e) => setNewScore(e.target.value)}
        />
        <button onClick={handleAdd} disabled={!newMember.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}
