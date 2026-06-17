import { useState } from 'react';
import { MongoJsonTree } from './MongoJsonTree';
import { jsonToShell } from '../../utils/mongo-shell-to-json';
import type { MongoView } from './ViewToggle';
import { idToShell } from './mongo-id';
import { MongoDocumentDetail } from './MongoDocumentDetail';
import { MongoFieldEditor } from './MongoFieldEditor';

interface MongoDocumentCardProps {
  readonly doc: Record<string, unknown>;
  readonly view: Exclude<MongoView, 'table'>;
  readonly editing?: boolean;
  readonly fieldNames?: readonly string[];
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
  readonly onSave?: (id: string | null, doc: Record<string, unknown>) => void;
  readonly onCancelEdit?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onSaveError?: () => void;
  readonly saveSignal?: number;
}

export function MongoDocumentCard({
  doc,
  view,
  editing,
  fieldNames,
  onEdit,
  onClone,
  onDelete,
  onSave,
  onCancelEdit,
  onDirtyChange,
  onSaveError,
  saveSignal,
}: MongoDocumentCardProps) {
  const id = idToShell(doc._id);
  const [editMode, setEditMode] = useState<'json' | 'fields'>('json');

  // in-card 编辑: Fields (结构化逐字段) 与 JSON (textarea) 两种模式, 列表上下文不动 (Compass 文档列表模型)
  if (editing && onSave) {
    return (
      <div className="mongo-doc-card mongo-doc-card-editing">
        <div className="mongo-edit-mode-toggle">
          <button
            className={`btn-small${editMode === 'fields' ? ' is-active' : ''}`}
            onClick={() => setEditMode('fields')}
          >
            Fields
          </button>
          <button
            className={`btn-small${editMode === 'json' ? ' is-active' : ''}`}
            onClick={() => setEditMode('json')}
          >
            JSON
          </button>
        </div>
        {editMode === 'fields' ? (
          <MongoFieldEditor
            document={doc}
            onSave={(ejson) => onSave(idToShell(doc._id), ejson)}
            onCancel={() => onCancelEdit?.()}
            onDirtyChange={onDirtyChange}
            onSaveError={onSaveError}
            saveSignal={saveSignal}
          />
        ) : (
          <MongoDocumentDetail
            document={doc}
            mode="edit"
            fieldNames={fieldNames ?? []}
            onClose={() => onCancelEdit?.()}
            onSave={onSave}
            onDelete={onDelete}
            onDirtyChange={onDirtyChange}
            onSaveError={onSaveError}
            saveSignal={saveSignal}
          />
        )}
      </div>
    );
  }

  const shellText = jsonToShell(JSON.stringify(doc, null, 2));
  // 投影排除 _id 时无法定位文档, 增删改禁用 (Copy 仍可用); review M7
  const hasId = doc._id != null;
  const noIdTitle = hasId ? undefined : 'projection 排除了 _id, 无法定位该文档进行增删改';

  return (
    <div className="mongo-doc-card">
      <div className="mongo-doc-card-actions">
        <button className="btn-small" title={noIdTitle ?? 'Edit'} disabled={!hasId} onClick={() => onEdit(doc)}>Edit</button>
        <button className="btn-small" title="Copy" onClick={() => navigator.clipboard.writeText(shellText)}>Copy</button>
        <button className="btn-small" title={noIdTitle ?? 'Clone (复制为新建, _id 可改)'} disabled={!hasId} onClick={() => onClone(doc)}>Clone</button>
        <button className="btn-small btn-danger" title={noIdTitle ?? 'Delete'} disabled={!hasId} onClick={() => onDelete(id)}>Delete</button>
      </div>
      {view === 'list'
        ? <MongoJsonTree value={doc} />
        : <pre className="mongo-doc-card-json">{shellText}</pre>}
    </div>
  );
}
