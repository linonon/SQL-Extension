import { useEffect, useMemo, useState } from 'react';
import { coerceToType, convertTags, documentToFields } from './mongo-field-editor';

interface MongoFieldEditorProps {
  readonly document: Record<string, unknown>;
  readonly onSave: (doc: Record<string, unknown>) => void;
  readonly onCancel: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

interface FieldRow {
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

export function MongoFieldEditor({ document: doc, onSave, onCancel, onDirtyChange }: MongoFieldEditorProps) {
  const initial = useMemo<FieldRow[]>(
    () => documentToFields(doc).map((f) => ({
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
  useEffect(() => { setRows(initial); }, [initial]);

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
    setRows((prev) => [...prev, { key: '', draft: '', original: '', editable: true, isNew: true, deleted: false }]);

  const [error, setError] = useState('');

  const save = () => {
    try {
      const out: Record<string, unknown> = {};
      for (const r of rows) {
        if (r.deleted || r.key.trim() === '') { continue; }
        // 可编辑值是用户字面量 (按类型 coerce, 不做 shell 转换);
        // 只读值来自 deepFormatValue, 才把其中真 shell-tag 还原为 EJSON.
        out[r.key] = r.editable ? coerceToType(r.original, r.draft) : convertTags(r.original);
      }
      setError('');
      onSave(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to build document');
    }
  };

  return (
    <div className="mongo-fe">
      <div className="mongo-fe-rows">
        {rows.map((r, i) => (
          <div
            key={`${r.key}-${i}`}
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
