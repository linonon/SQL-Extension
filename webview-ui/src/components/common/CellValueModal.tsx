import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ColumnInfo } from '../../../../src/types/query';
import { formatJsonLossless } from '../../utils/json-format';
import { validateCellValue } from '../../utils/cell-value-validator';

interface CellValueModalProps {
  readonly column: ColumnInfo;
  readonly value: unknown;
  // 不传即只读; 传了则 Apply / Set NULL 把新值交回 (null 表示 NULL), 由调用方记成待保存的编辑
  readonly onSave?: (value: string | null) => void;
  readonly onClose: () => void;
}

// 单元格完整值的查看 / 编辑弹窗. JSON 只读时默认按无损格式化展示, 可编辑时默认原文 (格式化会改写存储的文本),
// 两者都可切换; 动过文本之后不再可切, Apply 写回的就是编辑框里的文本
export function CellValueModal({ column, value, onSave, onClose }: CellValueModalProps) {
  const isNull = value === null || value === undefined;
  const raw = isNull ? '' : String(value);
  const formatted = useMemo(() => formatJsonLossless(raw), [raw]);
  const canFormat = formatted !== raw;
  const [showFormatted, setShowFormatted] = useState(canFormat && !onSave);
  // null = 没动过: Apply 等于不变 (NULL 格子打开是空串, 不能因此变成 '')
  const [edited, setEdited] = useState<string | null>(null);
  const [error, setError] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);
  const text = edited ?? (showFormatted ? formatted : raw);

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

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError('复制失败: 剪贴板不可用');
    }
  }, [text]);

  const handleApply = useCallback(() => {
    if (edited === null) {
      onClose();
      return;
    }
    const problem = validateCellValue(column, edited);
    if (problem) {
      setError(problem);
      return;
    }
    onSave?.(edited);
  }, [edited, column, onSave, onClose]);

  return (
    <div className="clone-row-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="clone-row-modal cell-value-modal">
        <div className="clone-row-header">
          {column.name} <span className="clone-row-field-type">{column.dataType}</span>
        </div>
        <div className="clone-row-body">
          <textarea
            className="cell-value-text"
            value={text}
            placeholder={isNull ? 'NULL' : ''}
            readOnly={!onSave}
            spellCheck={false}
            onChange={(e) => setEdited(e.target.value)}
          />
        </div>
        {error && <div className="clone-row-error">{error}</div>}
        <div className="clone-row-footer">
          <div className="cell-value-tools">
            {canFormat && (
              <button onClick={() => setShowFormatted((v) => !v)} disabled={edited !== null}>
                {showFormatted ? 'Raw' : 'Format'}
              </button>
            )}
            <button onClick={handleCopy}>Copy</button>
            {onSave && column.nullable && (
              <button onClick={() => onSave(null)} disabled={isNull && edited === null}>Set NULL</button>
            )}
          </div>
          <button className="clone-row-btn-cancel" onClick={onClose}>{onSave ? 'Cancel' : 'Close'}</button>
          {onSave && <button className="clone-row-btn-insert" onClick={handleApply}>Apply</button>}
        </div>
      </div>
    </div>
  );
}
