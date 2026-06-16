export type MongoView = 'list' | 'json' | 'table';

interface ViewToggleProps {
  readonly value: MongoView;
  readonly onChange: (v: MongoView) => void;
}

const OPTIONS: ReadonlyArray<{ key: MongoView; label: string }> = [
  { key: 'list', label: 'List' },
  { key: 'json', label: 'JSON' },
  { key: 'table', label: 'Table' },
];

export function ViewToggle({ value, onChange }: ViewToggleProps) {
  return (
    <div className="mongo-view-toggle" role="group" aria-label="View mode">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`mongo-view-toggle-btn${value === o.key ? ' active' : ''}`}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
