interface QueryResultsToolbarProps {
  readonly rowCount: number;
  readonly executionTime: number;
  readonly pendingCount: number;
  readonly editable: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
}

export function QueryResultsToolbar({
  rowCount,
  executionTime,
  pendingCount,
  editable,
  saving,
  onSave,
  onDiscard,
}: QueryResultsToolbarProps) {
  return (
    <div className="query-results-toolbar">
      <span className="query-results-toolbar-info">
        {rowCount} rows in {executionTime}ms
      </span>
      {editable && pendingCount > 0 && (
        <span className="query-results-toolbar-pending">
          {pendingCount} pending change{pendingCount > 1 ? 's' : ''}
        </span>
      )}
      {editable && (
        <div className="query-results-toolbar-actions">
          {pendingCount > 0 && (
            <button
              className="query-results-toolbar-discard"
              disabled={saving}
              title="撤销所有未保存的编辑, 恢复原值"
              onClick={onDiscard}
            >
              Discard
            </button>
          )}
          <button
            className="query-results-toolbar-save"
            disabled={pendingCount === 0 || saving}
            onClick={onSave}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}
