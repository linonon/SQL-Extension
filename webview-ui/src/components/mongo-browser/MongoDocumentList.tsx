import { MongoDocumentCard } from './MongoDocumentCard';
import type { MongoView } from './ViewToggle';

interface MongoDocumentListProps {
  readonly rows: readonly Record<string, unknown>[];
  readonly view: Exclude<MongoView, 'table'>;
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
}

export function MongoDocumentList({ rows, view, onEdit, onClone, onDelete }: MongoDocumentListProps) {
  return (
    <div className="mongo-doc-list">
      {rows.map((row, idx) => (
        <MongoDocumentCard
          key={String(row._id ?? idx)}
          doc={row}
          view={view}
          onEdit={onEdit}
          onClone={onClone}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
