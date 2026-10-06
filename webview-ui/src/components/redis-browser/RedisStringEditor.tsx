import { useCallback, useEffect, useState } from 'react';
import { formatJsonLossless } from '../../utils/json-format';

interface RedisStringEditorProps {
  readonly value: string;
  readonly onSave: (value: string) => void;
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function RedisStringEditor({ value, onSave }: RedisStringEditorProps) {
  const [text, setText] = useState('');
  const [canFormat, setCanFormat] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 加载时原样显示, 不自动 pretty: 未编辑时 Save 写回的就是读到的原文
  useEffect(() => {
    setText(value);
    setCanFormat(isJson(value));
    setDirty(false);
  }, [value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    onSave(text);
    setDirty(false);
  }, [text, onSave]);

  const handleFormat = useCallback(() => {
    setText(formatJsonLossless(text));
  }, [text]);

  return (
    <div className="redis-string-editor">
      <textarea
        value={text}
        onChange={handleChange}
        spellCheck={false}
      />
      <div className="editor-actions">
        <button onClick={handleSave} disabled={!dirty}>
          Save
        </button>
        {canFormat && (
          <button className="secondary" onClick={handleFormat}>
            Format JSON
          </button>
        )}
      </div>
    </div>
  );
}
