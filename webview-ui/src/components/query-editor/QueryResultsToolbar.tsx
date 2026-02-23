interface QueryResultsToolbarProps {
  readonly rowCount: number;
  readonly executionTime: number;
  readonly pendingCount: number;
  readonly editable: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
}

export function QueryResultsToolbar({
  rowCount,
  executionTime,
  pendingCount,
  editable,
  saving,
  onSave,
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
        <button
          className="query-results-toolbar-save"
          disabled={pendingCount === 0 || saving}
          onClick={onSave}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      )}
    </div>
  );
}
