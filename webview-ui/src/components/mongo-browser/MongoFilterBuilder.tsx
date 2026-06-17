import { useId, useState } from 'react';
import {
  buildFilterFromConditions,
  FILTER_OPS,
  type Condition,
  type FilterOp,
} from './mongo-filter-builder';

interface MongoFilterBuilderProps {
  readonly fieldNames: readonly string[];
  readonly onGenerate: (filterJson: string) => void;
  readonly onClose?: () => void;
}

const EMPTY_ROW: Condition = { field: '', op: '$eq', value: '' };

export function MongoFilterBuilder({ fieldNames, onGenerate, onClose }: MongoFilterBuilderProps) {
  const [rows, setRows] = useState<Condition[]>([{ ...EMPTY_ROW }]);
  const listId = useId();

  const update = (i: number, patch: Partial<Condition>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { ...EMPTY_ROW }]);
  const removeRow = (i: number) =>
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, j) => j !== i)));

  const apply = () => {
    onGenerate(buildFilterFromConditions(rows));
    onClose?.();
  };

  // $exists 用 true/false 下拉, 其它用文本框
  const needsValue = (op: FilterOp) => op !== '$exists';

  return (
    <div className="mongo-fb">
      <datalist id={listId}>
        {fieldNames.map((f) => <option key={f} value={f} />)}
      </datalist>
      <div className="mongo-fb-rows">
        {rows.map((row, i) => (
          <div className="mongo-fb-row" key={i}>
            <input
              className="mongo-fb-field"
              list={listId}
              placeholder="field"
              value={row.field}
              onChange={(e) => update(i, { field: e.target.value })}
            />
            <select
              className="mongo-fb-op"
              value={row.op}
              onChange={(e) => update(i, { op: e.target.value as FilterOp })}
            >
              {FILTER_OPS.map(({ op, label }) => <option key={op} value={op}>{label}</option>)}
            </select>
            {needsValue(row.op) ? (
              <input
                className="mongo-fb-value"
                placeholder="value"
                value={row.value}
                onChange={(e) => update(i, { value: e.target.value })}
              />
            ) : (
              <select
                className="mongo-fb-value"
                value={row.value || 'true'}
                onChange={(e) => update(i, { value: e.target.value })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            )}
            <button
              className="btn-small mongo-fb-remove"
              aria-label="移除条件"
              title="移除条件"
              onClick={() => removeRow(i)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="mongo-fb-actions">
        <button className="btn-small" onClick={addRow}>+ 添加条件</button>
        <button className="btn-small btn-primary" onClick={apply}>应用筛选</button>
      </div>
    </div>
  );
}
