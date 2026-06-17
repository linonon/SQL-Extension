import { MongoJsonTree } from './MongoJsonTree';
import { jsonToShell } from '../../utils/mongo-shell-to-json';
import type { MongoView } from './ViewToggle';
import { idToShell } from './mongo-id';

interface MongoDocumentCardProps {
  readonly doc: Record<string, unknown>;
  readonly view: Exclude<MongoView, 'table'>;
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
}

export function MongoDocumentCard({ doc, view, onEdit, onClone, onDelete }: MongoDocumentCardProps) {
  const id = idToShell(doc._id);
  const shellText = jsonToShell(JSON.stringify(doc, null, 2));

  return (
    <div className="mongo-doc-card">
      <div className="mongo-doc-card-actions">
        <button className="btn-small" title="Edit" onClick={() => onEdit(doc)}>Edit</button>
        <button className="btn-small" title="Copy" onClick={() => navigator.clipboard.writeText(shellText)}>Copy</button>
        <button className="btn-small" title="Clone (coming soon)" disabled onClick={() => onClone(doc)}>Clone</button>
        <button className="btn-small btn-danger" title="Delete" onClick={() => onDelete(id)}>Delete</button>
      </div>
      {view === 'list'
        ? <MongoJsonTree value={doc} />
        : <pre className="mongo-doc-card-json">{shellText}</pre>}
    </div>
  );
}
