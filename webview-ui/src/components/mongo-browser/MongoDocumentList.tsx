import { MongoDocumentCard } from './MongoDocumentCard';
import { MongoDocumentDetail } from './MongoDocumentDetail';
import { idToShell } from './mongo-id';
import type { MongoView } from './ViewToggle';

interface MongoDocumentListProps {
  readonly rows: readonly Record<string, unknown>[];
  readonly view: Exclude<MongoView, 'table'>;
  readonly fieldNames?: readonly string[];
  // 正在 in-card 编辑的现存文档 _id (idToShell 形式); null 表示无
  readonly editingId?: string | null;
  // 列表顶部的新建/克隆卡片: undefined 表示不显示, 否则为 seed (空对象=空白新建)
  readonly composing?: Record<string, unknown> | null;
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
  readonly onSave?: (id: string | null, doc: Record<string, unknown>) => void;
  readonly onCancelEdit?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly saveSignal?: number;
}

export function MongoDocumentList({
  rows,
  view,
  fieldNames,
  editingId,
  composing,
  onEdit,
  onClone,
  onDelete,
  onSave,
  onCancelEdit,
  onDirtyChange,
  saveSignal,
}: MongoDocumentListProps) {
  const hasSeed = composing != null && Object.keys(composing).length > 0;
  return (
    <div className="mongo-doc-list">
      {composing != null && onSave && (
        <div className="mongo-doc-card mongo-doc-card-editing mongo-doc-card-composing">
          {hasSeed && (
            <div className="mongo-clone-hint">
              Clone: 保存将按当前 _id 新建文档; 原文档仍保留. 如意在更名 _id, 请另行删除原文档.
            </div>
          )}
          <MongoDocumentDetail
            document={hasSeed ? composing : null}
            mode="insert"
            fieldNames={fieldNames ?? []}
            onClose={() => onCancelEdit?.()}
            onSave={onSave}
            onDelete={() => {}}
            onDirtyChange={onDirtyChange}
            saveSignal={saveSignal}
          />
        </div>
      )}
      {rows.map((row, idx) => {
        const rowId = idToShell(row._id);
        const isEditing = editingId != null && rowId === editingId;
        return (
          <MongoDocumentCard
            key={String(row._id ?? idx)}
            doc={row}
            view={view}
            editing={isEditing}
            fieldNames={fieldNames}
            onEdit={onEdit}
            onClone={onClone}
            onDelete={onDelete}
            onSave={onSave}
            onCancelEdit={onCancelEdit}
            onDirtyChange={onDirtyChange}
            saveSignal={saveSignal}
          />
        );
      })}
    </div>
  );
}
