import { useEffect, useMemo, useRef, useState } from 'react';
import { coerceToType, convertTags, documentToFields } from './mongo-field-editor';
import { validateEjsonValues } from './mongo-editor-syntax';

interface MongoFieldEditorProps {
  readonly document: Record<string, unknown>;
  readonly onSave: (doc: Record<string, unknown>) => void;
  readonly onCancel: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onSaveError?: () => void;
  readonly saveSignal?: number;
}

// 合成稳定 id, 作 React key (不可用可变的 r.key, 否则编辑 key 时整行 remount 失焦)
let rowIdSeq = 0;
const nextRowId = (): string => `fe-${rowIdSeq++}`;

interface FieldRow {
  readonly id: string;
  key: string;
  draft: string;          // 可编辑字段的文本草稿
  readonly original: unknown;
  readonly editable: boolean;
  readonly isNew: boolean;
  deleted: boolean;
}

function readonlyDisplay(value: unknown): string {
  if (value === null || value === undefined) { return 'null'; }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function MongoFieldEditor({ document: doc, onSave, onCancel, onDirtyChange, onSaveError, saveSignal }: MongoFieldEditorProps) {
  const initial = useMemo<FieldRow[]>(
    () => documentToFields(doc).map((f) => ({
      id: nextRowId(),
      key: f.key,
      draft: f.editable ? String(f.value) : '',
      original: f.value,
      editable: f.editable,
      isNew: false,
      deleted: false,
    })),
    [doc],
  );
  const [rows, setRows] = useState<FieldRow[]>(initial);
  // 仅当切换到不同 _id 的文档时重置; 同 _id 的后台 refetch (新对象引用) 不清空在编辑的草稿
  const docIdRef = useRef(doc._id);
  useEffect(() => {
    if (docIdRef.current !== doc._id) { docIdRef.current = doc._id; setRows(initial); }
  }, [doc._id, initial]);

  const isModified = (r: FieldRow): boolean =>
    r.isNew || r.deleted || (r.editable && r.draft !== String(r.original));

  const dirty = rows.some(isModified);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const patch = (i: number, p: Partial<FieldRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const revert = (i: number) =>
    setRows((prev) => prev.map((r, j) => {
      if (j !== i) { return r; }
      if (r.isNew) { return r; } // 新增字段无"原值"可还原 (用删除)
      return { ...r, draft: String(r.original), deleted: false };
    }));

  const addField = () =>
    setRows((prev) => [...prev, { id: nextRowId(), key: '', draft: '', original: '', editable: true, isNew: true, deleted: false }]);

  const [error, setError] = useState('');

  const save = () => {
    try {
      // 新增字段填了值却没填 key -> 阻止保存而非静默丢弃
      const orphan = rows.find((r) => !r.deleted && r.key.trim() === '' && r.isNew && r.draft.trim() !== '');
      if (orphan) { setError('新增字段缺少字段名 (key)'); onSaveError?.(); return; }

      const out: Record<string, unknown> = {};
      for (const r of rows) {
        if (r.deleted || r.key.trim() === '') { continue; }
        // 可编辑值是用户字面量 (按类型 coerce, 不做 shell 转换);
        // 只读值来自 deepFormatValue, 才把其中真 shell-tag 还原为 EJSON.
        out[r.key] = r.editable ? coerceToType(r.original, r.draft) : convertTags(r.original);
      }
      // 与 JSON 模式一致的值合法性闸: 拦越界整数 / 非法日期等, 不依赖后端 round-trip 才报错
      const problem = validateEjsonValues(out);
      if (problem) { setError(problem.message); onSaveError?.(); return; }
      setError('');
      onSave(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to build document');
      onSaveError?.();
    }
  };

  // 父级"未保存切换/Apply"对话框点 Save 时通过 saveSignal 触发本编辑器保存
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (saveSignal) { save(); } }, [saveSignal]);

  return (
    <div className="mongo-fe">
      <div className="mongo-fe-rows">
        {rows.map((r, i) => (
          <div
            key={r.id}
            className={`mongo-fe-row${isModified(r) && !r.deleted ? ' is-modified' : ''}${r.deleted ? ' is-deleted' : ''}`}
          >
            {r.isNew ? (
              <input
                className="mongo-fe-key-input"
                value={r.key}
                placeholder="field"
                onChange={(e) => patch(i, { key: e.target.value })}
              />
            ) : (
              <span className="mongo-fe-key">{r.key}</span>
            )}
            {r.editable ? (
              <input
                className="mongo-fe-value-input"
                value={r.draft}
                disabled={r.deleted}
                onChange={(e) => patch(i, { draft: e.target.value })}
              />
            ) : (
              <span className="mongo-fe-value-readonly" title="只读 (用 JSON 模式编辑)">
                {readonlyDisplay(r.original)}
              </span>
            )}
            {(isModified(r) && !r.isNew) && (
              <button className="btn-small" aria-label={`还原字段 ${r.key}`} title="还原" onClick={() => revert(i)}>↺</button>
            )}
            <button className="btn-small btn-danger" aria-label={`删除字段 ${r.key}`} title="删除字段" onClick={() => patch(i, { deleted: !r.deleted })}>×</button>
          </div>
        ))}
      </div>
      {error && <div className="mongo-fe-error">{error}</div>}
      <div className="mongo-fe-actions">
        <button className="btn-small" onClick={addField}>+ 添加字段</button>
        <span className="mongo-fe-spacer" style={{ flex: 1 }} />
        <button className="btn-small btn-primary" onClick={save} disabled={!dirty}>Save</button>
        <button className="btn-small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
