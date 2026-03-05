import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColumnInfo } from '../../types/database';

interface CloneRowModalProps {
  readonly row: Record<string, unknown>;
  readonly columns: ColumnInfo[];
  readonly onSubmit: (row: Record<string, unknown>) => void;
  readonly onClose: () => void;
}

export function CloneRowModal({ row, columns, onSubmit, onClose }: CloneRowModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const col of columns) {
      const isAutoIncrement = col.extra?.toLowerCase().includes('auto_increment');
      if (isAutoIncrement) {
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
      const isAutoIncrement = col.extra?.toLowerCase().includes('auto_increment');
      flags[col.name] = !isAutoIncrement && (row[col.name] === null || row[col.name] === undefined);
    }
    return flags;
  });
  const overlayRef = useRef<HTMLDivElement>(null);

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
      const isAutoIncrement = col.extra?.toLowerCase().includes('auto_increment');
      if (isAutoIncrement && values[col.name] === '') {
        continue;
      }
      if (nullFlags[col.name]) {
        result[col.name] = null;
      } else {
        result[col.name] = values[col.name];
      }
    }
    onSubmit(result);
  }, [columns, values, nullFlags, onSubmit]);

  return (
    <div className="clone-row-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="clone-row-modal">
        <div className="clone-row-header">Clone as New Row</div>
        <div className="clone-row-body">
          {columns.map((col) => {
            const isAutoIncrement = col.extra?.toLowerCase().includes('auto_increment');
            const isNull = nullFlags[col.name];
            return (
              <div key={col.name} className="clone-row-field">
                <div className="clone-row-field-label">
                  <span className="clone-row-field-name">{col.name}</span>
                  <span className="clone-row-field-type">
                    {col.dataType}
                    {col.isPrimaryKey && <span className="column-badge pk">PK</span>}
                    {isAutoIncrement && <span className="column-badge auto">AUTO</span>}
                  </span>
                </div>
                <div className="clone-row-field-input">
                  <input
                    type="text"
                    value={isNull ? '' : values[col.name]}
                    placeholder={isAutoIncrement ? 'AUTO' : col.nullable ? 'NULL' : ''}
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
        <div className="clone-row-footer">
          <button className="clone-row-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="clone-row-btn-insert" onClick={handleSubmit}>Insert</button>
        </div>
      </div>
    </div>
  );
}
