import { MongoDocumentCard } from './MongoDocumentCard';
import { MongoDocumentDetail } from './MongoDocumentDetail';
import { idToShell } from './mongo-id';
import type { MongoView } from './ViewToggle';

interface MongoDocumentListProps {
  readonly rows: readonly Record<string, unknown>[];
  readonly view: Exclude<MongoView, 'table'>;
  // projection 不是顶层字段 0/1 取舍 (子路径 / 表达式), 写回会丢字段或写错值: 禁用 Edit / Clone
  readonly readOnly?: boolean;
  readonly fieldNames?: readonly string[];
  // 正在 in-card 编辑的现存文档 _id (idToShell 形式); null 表示无
  readonly editingId?: string | null;
  // 列表顶部的新建/克隆卡片: undefined 表示不显示, 否则为 seed (空对象=空白新建)
  readonly composing?: Record<string, unknown> | null;
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  readonly onDelete: (id: unknown) => void;
  readonly onSave?: (original: Record<string, unknown> | null, doc: Record<string, unknown>) => void;
  readonly onCancelEdit?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onSaveError?: () => void;
  readonly saveSignal?: number;
}

export function MongoDocumentList({
  rows,
  view,
  readOnly,
  fieldNames,
  editingId,
  composing,
  onEdit,
  onClone,
  onDelete,
  onSave,
  onCancelEdit,
  onDirtyChange,
  onSaveError,
  saveSignal,
}: MongoDocumentListProps) {
  const hasSeed = composing != null && Object.keys(composing).length > 0;
  return (
    <div className="mongo-doc-list">
      {composing != null && onSave && (
        <div className="mongo-doc-card mongo-doc-card-editing mongo-doc-card-composing">
          {hasSeed && (
            <div className="mongo-clone-hint">
              Clone: 保存将新建文档, 原文档仍保留. 不改 _id 则生成新 ObjectId; 改了 _id 则用新值 (如意在更名 _id, 请另行删除原文档).
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
            onSaveError={onSaveError}
            saveSignal={saveSignal}
          />
        </div>
      )}
      {rows.map((row, idx) => {
        const rowId = idToShell(row._id);
        const isEditing = editingId != null && rowId === editingId;
        return (
          <MongoDocumentCard
            key={rowId || idx}
            doc={row}
            view={view}
            readOnly={readOnly}
            editing={isEditing}
            fieldNames={fieldNames}
            onEdit={onEdit}
            onClone={onClone}
            onDelete={onDelete}
            onSave={onSave}
            onCancelEdit={onCancelEdit}
            onDirtyChange={onDirtyChange}
            onSaveError={onSaveError}
            saveSignal={saveSignal}
          />
        );
      })}
    </div>
  );
}
