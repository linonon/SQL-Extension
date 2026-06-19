import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ColumnInfo } from '../../types/database';
import { isAutoFilledColumn } from '../../utils/insert-row';
import { validateRow } from '../../utils/cell-value-validator';

interface CloneRowModalProps {
  readonly row: Record<string, unknown>;
  readonly columns: ColumnInfo[];
  readonly onSubmit: (row: Record<string, unknown>) => void;
  readonly onClose: () => void;
}

export function CloneRowModal({ row, columns, onSubmit, onClose }: CloneRowModalProps) {
  // 自动填充列 (MySQL auto_increment / PG serial-nextval / identity) 克隆时清空, 让 DB 自增
  const autoIncrementCols = useMemo(() => {
    const set = new Set<string>();
    for (const col of columns) {
      if (isAutoFilledColumn(col)) {
        set.add(col.name);
      }
    }
    return set;
  }, [columns]);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const col of columns) {
      if (autoIncrementCols.has(col.name)) {
        initial[col.name] = '';
      } else {
        const v = row[col.name];
        initial[col.name] = v === null || v === undefined ? '' : String(v);
      }
    }
    return initial;
  });
  const [nullFlags, setNullFlags] = useState<Record<string, boolean>>(() => {
    const flags: Record<string, boolean> = {};
    for (const col of columns) {
      flags[col.name] = !autoIncrementCols.has(col.name) && (row[col.name] === null || row[col.name] === undefined);
    }
    return flags;
  });
  const overlayRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const handleChange = useCallback((colName: string, value: string) => {
    setValues((prev) => ({ ...prev, [colName]: value }));
    setNullFlags((prev) => ({ ...prev, [colName]: false }));
  }, []);

  const handleNullToggle = useCallback((colName: string) => {
    setNullFlags((prev) => {
      const next = { ...prev, [colName]: !prev[colName] };
      if (next[colName]) {
        setValues((v) => ({ ...v, [colName]: '' }));
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    const result: Record<string, unknown> = {};
    for (const col of columns) {
      if (autoIncrementCols.has(col.name) && values[col.name] === '') {
        continue;
      }
      if (nullFlags[col.name]) {
        result[col.name] = null;
        continue;
      }
      // 非空列留空 -> 省略该 key, 让 DB 应用默认值, 而非写入 '' (MySQL 非严格模式静默存 0/无效日期, PG 报类型错)
      if (values[col.name] === '' && !col.nullable) {
        continue;
      }
      result[col.name] = values[col.name];
    }
    // 提交前值校验: 拦非数字/非法日期等静默写错值
    const problem = validateRow(columns, result);
    if (problem) {
      setError(problem);
      return;
    }
    onSubmit(result);
  }, [columns, autoIncrementCols, values, nullFlags, onSubmit]);

  return (
    <div className="clone-row-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="clone-row-modal">
        <div className="clone-row-header">Clone as New Row</div>
        <div className="clone-row-body">
          {columns.map((col) => {
            const isAutoInc = autoIncrementCols.has(col.name);
            const isNull = nullFlags[col.name];
            return (
              <div key={col.name} className="clone-row-field">
                <div className="clone-row-field-label">
                  <span className="clone-row-field-name">{col.name}</span>
                  <span className="clone-row-field-type">
                    {col.dataType}
                    {col.isPrimaryKey && <span className="column-badge pk">PK</span>}
                    {isAutoInc && <span className="column-badge auto">AUTO</span>}
                  </span>
                </div>
                <div className="clone-row-field-input">
                  <input
                    type="text"
                    value={isNull ? '' : values[col.name]}
                    placeholder={isAutoInc ? 'AUTO' : col.nullable ? 'NULL' : ''}
                    disabled={isNull}
                    onChange={(e) => handleChange(col.name, e.target.value)}
                  />
                  {col.nullable && (
                    <label className="clone-row-null-toggle">
                      <input
                        type="checkbox"
                        checked={isNull}
                        onChange={() => handleNullToggle(col.name)}
                      />
                      NULL
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {error && <div className="clone-row-error">{error}</div>}
        <div className="clone-row-footer">
          <button className="clone-row-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="clone-row-btn-insert" onClick={handleSubmit}>Insert</button>
        </div>
      </div>
    </div>
  );
}
