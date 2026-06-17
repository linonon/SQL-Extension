import { MongoJsonTree } from './MongoJsonTree';
import { jsonToShell } from '../../utils/mongo-shell-to-json';
import type { MongoView } from './ViewToggle';
import { idToShell } from './mongo-id';
import { MongoDocumentDetail } from './MongoDocumentDetail';

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
  saveSignal,
}: MongoDocumentCardProps) {
  const id = idToShell(doc._id);

  // in-card 编辑: 复用 MongoDocumentDetail 编辑器内核, 列表上下文不动 (Compass 文档列表模型)
  if (editing && onSave) {
    return (
      <div className="mongo-doc-card mongo-doc-card-editing">
        <MongoDocumentDetail
          document={doc}
          mode="edit"
          fieldNames={fieldNames ?? []}
          onClose={() => onCancelEdit?.()}
          onSave={onSave}
          onDelete={onDelete}
          onDirtyChange={onDirtyChange}
          saveSignal={saveSignal}
        />
      </div>
    );
  }

  const shellText = jsonToShell(JSON.stringify(doc, null, 2));

  return (
    <div className="mongo-doc-card">
      <div className="mongo-doc-card-actions">
        <button className="btn-small" title="Edit" onClick={() => onEdit(doc)}>Edit</button>
        <button className="btn-small" title="Copy" onClick={() => navigator.clipboard.writeText(shellText)}>Copy</button>
        <button className="btn-small" title="Clone (复制为新建, _id 可改)" onClick={() => onClone(doc)}>Clone</button>
        <button className="btn-small btn-danger" title="Delete" onClick={() => onDelete(id)}>Delete</button>
      </div>
      {view === 'list'
        ? <MongoJsonTree value={doc} />
        : <pre className="mongo-doc-card-json">{shellText}</pre>}
    </div>
  );
}
