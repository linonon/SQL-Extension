import { useCallback, useEffect, useState } from 'react';

interface RedisStringEditorProps {
  readonly value: string;
  readonly onSave: (value: string) => void;
}

function tryFormatJson(value: string): { readonly formatted: string; readonly isJson: boolean } {
  try {
    const parsed = JSON.parse(value);
    return { formatted: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { formatted: value, isJson: false };
  }
}

export function RedisStringEditor({ value, onSave }: RedisStringEditorProps) {
  const [text, setText] = useState('');
  const [isJson, setIsJson] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const { formatted, isJson: detected } = tryFormatJson(value);
    setText(formatted);
    setIsJson(detected);
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
    const { formatted, isJson: detected } = tryFormatJson(text);
    if (detected) {
      setText(formatted);
      setIsJson(true);
    }
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
        {isJson && (
          <button className="secondary" onClick={handleFormat}>
            Format JSON
          </button>
        )}
      </div>
    </div>
  );
}
