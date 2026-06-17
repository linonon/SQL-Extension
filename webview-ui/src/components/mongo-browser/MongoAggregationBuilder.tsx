import { useState } from 'react';
import { AGG_STAGE_OPS, buildAggregateQuery, type AggStage } from './mongo-aggregation';

interface MongoAggregationBuilderProps {
  readonly collection: string;
  readonly onGenerate: (query: string) => void;
}

const newStage = (): AggStage => ({ op: '$match', body: '', enabled: true });

export function MongoAggregationBuilder({ collection, onGenerate }: MongoAggregationBuilderProps) {
  const [coll, setColl] = useState(collection || 'collection');
  const [stages, setStages] = useState<AggStage[]>([newStage()]);
  const [error, setError] = useState('');

  const patch = (i: number, p: Partial<AggStage>) =>
    setStages((prev) => prev.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const addStage = () => setStages((prev) => [...prev, newStage()]);
  const removeStage = (i: number) =>
    setStages((prev) => (prev.length === 1 ? prev : prev.filter((_, j) => j !== i)));
  const move = (i: number, dir: -1 | 1) =>
    setStages((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) { return prev; }
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const apply = () => {
    try {
      const query = buildAggregateQuery(coll, stages);
      setError('');
      onGenerate(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'invalid pipeline');
    }
  };

  return (
    <div className="mongo-agg">
      <div className="mongo-agg-top">
        <label className="mongo-agg-coll-label">Collection:</label>
        <input
          className="mongo-agg-collection"
          value={coll}
          onChange={(e) => setColl(e.target.value)}
          placeholder="collection"
        />
      </div>
      <div className="mongo-agg-stages">
        {stages.map((s, i) => (
          <div className="mongo-agg-stage" key={i}>
            <div className="mongo-agg-stage-head">
              <input
                type="checkbox"
                checked={s.enabled}
                title="启用/禁用此 stage"
                onChange={(e) => patch(i, { enabled: e.target.checked })}
              />
              <select
                className="mongo-agg-op"
                value={s.op}
                onChange={(e) => patch(i, { op: e.target.value })}
              >
                {AGG_STAGE_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              <span className="mongo-agg-stage-spacer" style={{ flex: 1 }} />
              <button className="btn-small" aria-label="上移 stage" title="上移" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button className="btn-small" aria-label="下移 stage" title="下移" onClick={() => move(i, 1)} disabled={i === stages.length - 1}>↓</button>
              <button className="btn-small btn-danger" aria-label="移除 stage" title="移除" onClick={() => removeStage(i)}>×</button>
            </div>
            <textarea
              className="mongo-agg-body"
              value={s.body}
              onChange={(e) => patch(i, { body: e.target.value })}
              placeholder={`${s.op} body, 如 {"field": 1}`}
              spellCheck={false}
              rows={2}
            />
          </div>
        ))}
      </div>
      {error && <div className="mongo-agg-error">{error}</div>}
      <div className="mongo-agg-actions">
        <button className="btn-small" onClick={addStage}>+ Stage</button>
        <button className="btn-small btn-primary" onClick={apply}>应用到查询</button>
      </div>
    </div>
  );
}
