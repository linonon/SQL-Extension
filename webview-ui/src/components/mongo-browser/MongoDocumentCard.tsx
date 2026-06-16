import { MongoJsonTree } from './MongoJsonTree';
import { jsonToShell } from '../../utils/mongo-shell-to-json';
import type { MongoView } from './ViewToggle';

interface MongoDocumentCardProps {
  readonly doc: Record<string, unknown>;
  readonly view: Exclude<MongoView, 'table'>;
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
}

export function MongoDocumentCard({ doc, view, onEdit, onClone, onDelete }: MongoDocumentCardProps) {
  const id = String(doc._id ?? '');
  const shellText = jsonToShell(JSON.stringify(doc, null, 2));

  return (
    <div className="mongo-doc-card">
      <div className="mongo-doc-card-actions">
        <button className="btn-small" aria-label="Edit" title="Edit" onClick={() => onEdit(doc)}><i className="ti ti-edit" /></button>
        <button className="btn-small" aria-label="Copy" title="Copy" onClick={() => navigator.clipboard.writeText(shellText)}><i className="ti ti-copy" /></button>
        <button className="btn-small" aria-label="Clone" title="Clone (new _id)" onClick={() => onClone(doc)}><i className="ti ti-copy-plus" /></button>
        <button className="btn-small btn-danger" aria-label="Delete" title="Delete" onClick={() => onDelete(id)}><i className="ti ti-trash" /></button>
      </div>
      {view === 'list'
        ? <MongoJsonTree value={doc} />
        : <pre className="mongo-doc-card-json">{shellText}</pre>}
    </div>
  );
}
