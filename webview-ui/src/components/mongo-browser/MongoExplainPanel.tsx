import type { MongoExplainSummary } from '../../types/messages';

interface MongoExplainPanelProps {
  readonly summary?: MongoExplainSummary;
  readonly error?: string;
  readonly loading?: boolean;
  readonly onClose: () => void;
}

export function MongoExplainPanel({ summary, error, loading, onClose }: MongoExplainPanelProps) {
  return (
    <div className="mongo-explain-panel">
      <div className="mongo-explain-header">
        <span className="mongo-explain-title">Explain</span>
        <button className="btn-small" onClick={onClose} aria-label="Close explain">✕</button>
      </div>
      <div className="mongo-explain-body">
        {loading && <span>Running explain...</span>}
        {!loading && error && <span className="mongo-explain-error">explain failed: {error}</span>}
        {!loading && !error && summary && (
          <>
            <div className="mongo-explain-row">
              <span
                className={`mongo-explain-stage ${summary.isCollScan ? 'is-collscan' : 'is-ixscan'}`}
              >
                {summary.stage}
              </span>
              {summary.indexName && <span className="mongo-explain-index">index: {summary.indexName}</span>}
            </div>
            {summary.isCollScan && (
              <div className="mongo-explain-warn">
                Warning: 全表扫描 (无索引), 建议对查询字段加索引.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
