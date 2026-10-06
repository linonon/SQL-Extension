import { useState } from 'react';
import { MongoJsonTree } from './MongoJsonTree';
import { jsonToShell } from '../../utils/mongo-shell-to-json';
import type { MongoView } from './ViewToggle';
import { MongoDocumentDetail } from './MongoDocumentDetail';
import { MongoFieldEditor } from './MongoFieldEditor';
import { convertTags } from './mongo-field-editor';
import { useReadOnly } from '../../hooks/useReadOnly';

interface MongoDocumentCardProps {
  readonly doc: Record<string, unknown>;
  readonly view: Exclude<MongoView, 'table'>;
  // projection 不是顶层字段 0/1 取舍 (子路径 / 表达式), 写回会丢字段或写错值: 禁用 Edit / Clone
  readonly readOnly?: boolean;
  readonly editing?: boolean;
  readonly fieldNames?: readonly string[];
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  // id: 文档 _id 的 EJSON 值
  readonly onDelete: (id: unknown) => void;
  // original: 编辑器打开时的文档; doc: 编辑结果. 都是 EJSON
  readonly onSave?: (original: Record<string, unknown> | null, doc: Record<string, unknown>) => void;
  readonly onCancelEdit?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onSaveError?: () => void;
  readonly saveSignal?: number;
}

export function MongoDocumentCard({
  doc,
  view,
  readOnly,
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
  const connectionReadOnly = useReadOnly();
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
            onSave={onSave}
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
  // 只读连接, 或投影排除 _id 时无法定位文档: 增删改禁用 (Copy 仍可用)
  const hasId = doc._id != null;
  const deleteBlockedTitle = connectionReadOnly ? 'Connection is read-only'
    : hasId ? undefined : 'projection 排除了 _id, 无法定位该文档进行增删改';
  const writeBlockedTitle = deleteBlockedTitle ?? (readOnly ? 'Only a projection of top-level fields with 0/1 values can be edited' : undefined);

  return (
    <div className="mongo-doc-card">
      <div className="mongo-doc-card-actions">
        <button className="btn-small" title={writeBlockedTitle ?? 'Edit'} disabled={writeBlockedTitle != null} onClick={() => onEdit(doc)}>Edit</button>
        <button className="btn-small" title="Copy" onClick={() => navigator.clipboard.writeText(shellText)}>Copy</button>
        <button className="btn-small" title={writeBlockedTitle ?? 'Clone (复制为新建, _id 可改)'} disabled={writeBlockedTitle != null} onClick={() => onClone(doc)}>Clone</button>
        <button className="btn-small btn-danger" title={deleteBlockedTitle ?? 'Delete'} disabled={deleteBlockedTitle != null} onClick={() => onDelete(convertTags(doc._id))}>Delete</button>
      </div>
      {view === 'list'
        ? <MongoJsonTree value={doc} />
        : <pre className="mongo-doc-card-json">{shellText}</pre>}
    </div>
  );
}
