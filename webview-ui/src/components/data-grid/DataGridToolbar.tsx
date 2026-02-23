interface DataGridToolbarProps {
  readonly tableName: string;
  readonly onRefresh: () => void;
  readonly onInsert: () => void;
  readonly onDelete: () => void;
  readonly hasSelection: boolean;
}

export function DataGridToolbar({
  tableName,
  onRefresh,
  onInsert,
  onDelete,
  hasSelection,
}: DataGridToolbarProps) {
  return (
    <div className="data-grid-toolbar">
      <span className="table-name">{tableName}</span>
      <button onClick={onRefresh}>Refresh</button>
      <button onClick={onInsert}>Insert Row</button>
      <button onClick={onDelete} disabled={!hasSelection}>
        Delete Selected
      </button>
    </div>
  );
}
