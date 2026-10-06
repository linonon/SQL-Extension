import { useMemo, useState } from 'react';
import { formatJsonLossless } from '../../utils/json-format';

interface RedisValueInputProps {
  readonly value: string;
  readonly dirty: boolean;
  readonly readOnly: boolean;
  readonly onChange: (value: string) => void;
}

// hash value / list item 的编辑框. 一直是 textarea (input 会吞掉换行), 收起时只占一行且 Enter 不换行;
// 展开后随内容长高, JSON 可无损格式化: 可写时格式化是一次显式编辑, 保存写回的就是框里的文本; 只读时只改显示
export function RedisValueInput({ value, dirty, readOnly, onChange }: RedisValueInputProps) {
  const [expanded, setExpanded] = useState(false);
  const [pretty, setPretty] = useState(false);
  const formatted = useMemo(() => (expanded ? formatJsonLossless(value) : value), [expanded, value]);
  const shown = readOnly && pretty ? formatted : value;

  return (
    <>
      <textarea
        className={`value${expanded ? ' expanded' : ''}${dirty ? ' editing-dirty' : ''}`}
        rows={1}
        spellCheck={false}
        value={shown}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!expanded && e.key === 'Enter') e.preventDefault();
        }}
      />
      {expanded && formatted !== shown && (
        <button
          className="btn-small secondary"
          onClick={() => (readOnly ? setPretty(true) : onChange(formatted))}
        >
          Format JSON
        </button>
      )}
      <button
        className="btn-icon value-expand"
        title={expanded ? 'Collapse value' : 'Expand value'}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '\u25B4' : '\u25BE'}
      </button>
    </>
  );
}
