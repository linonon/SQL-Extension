import { useCallback, useMemo, useState } from 'react';
import { useMongoAutocomplete } from '../../hooks/useMongoAutocomplete';
import { convertShellToJson, stripShellTypes, jsonToShell } from '../../utils/mongo-shell-to-json';
import { AutocompletePopup } from '../sql-editor/AutocompletePopup';

type DetailMode = 'edit' | 'insert';

interface MongoDocumentDetailProps {
  readonly document: Record<string, unknown> | null;
  readonly mode: DetailMode;
  readonly fieldNames: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (id: string | null, doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
}

function stripId(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id, ...rest } = doc;
  return rest;
}

// 从 shell 语法中提取原始 ID, 用于 update/delete 查询
// ObjectId("abc...") -> "abc...", 其他原样返回
export function extractRawId(idValue: string): string {
  const m = idValue.match(/^ObjectId\("([0-9a-fA-F]{24})"\)$/);
  return m ? m[1] : idValue;
}

export function MongoDocumentDetail({ document, mode, fieldNames, onClose, onSave, onDelete }: MongoDocumentDetailProps) {
  const displayId = document ? String(document._id ?? '') : '';
  // docId 是给查询用的原始 hex, autoConvertIds 才能识别
  const docId = extractRawId(displayId);
  const initialText = useMemo(
    () => document ? jsonToShell(JSON.stringify(stripId(document), null, 2)) : '{}',
    [document]
  );

  const [text, setText] = useState(initialText);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const dirty = text !== initialText;

  const {
    textareaRef, completionItems, selectedIndex, popupPos,
    handleChange, handleKeyDown, applyCompletion,
  } = useMongoAutocomplete({ fieldNames, value: text, onChange: setText });

  const handleSave = useCallback(() => {
    try {
      const jsonText = convertShellToJson(text);
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      setError('');
      onSave(mode === 'edit' ? docId : null, parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  }, [text, mode, docId, onSave]);

  const handleDelete = useCallback(() => {
    onDelete(docId);
  }, [docId, onDelete]);

  const showToast = useCallback((msg: string) => {
    setToast('');
    // 强制下一帧重新挂载, 保证动画重新触发
    requestAnimationFrame(() => setToast(msg));
  }, []);

  const handleCopyShell = useCallback(() => {
    navigator.clipboard.writeText(text);
    showToast('Copied as Shell');
  }, [text, showToast]);

  const handleCopyEjson = useCallback(() => {
    navigator.clipboard.writeText(convertShellToJson(text));
    showToast('Copied as EJSON');
  }, [text, showToast]);

  const handleCopyJson = useCallback(() => {
    navigator.clipboard.writeText(stripShellTypes(text));
    showToast('Copied as JSON');
  }, [text, showToast]);

  return (
    <div className="mongo-document-detail">
      <div className="detail-header">
        <h3>{mode === 'edit' ? 'Edit Document' : 'New Document'}</h3>
        <div className="detail-header-actions">
          <div className="detail-copy-group">
            <button className="btn-small" onClick={handleCopyShell} title="Copy as mongo shell syntax">Shell</button>
            <button className="btn-small" onClick={handleCopyEjson} title="Copy as Extended JSON">EJSON</button>
            <button className="btn-small" onClick={handleCopyJson} title="Copy as plain JSON">JSON</button>
            {toast && (
              <span className="detail-copy-toast" onAnimationEnd={() => setToast('')}>{toast}</span>
            )}
          </div>
          {mode === 'edit' && (
            <button className="btn-small btn-danger" onClick={handleDelete}>Delete</button>
          )}
          <button
            className="btn-small btn-primary"
            onClick={handleSave}
            disabled={!dirty && mode === 'edit'}
          >
            Save
          </button>
          <button className="btn-small" onClick={onClose}>Cancel</button>
        </div>
      </div>
      {mode === 'edit' && displayId && (
        <div className="detail-id-bar">_id: {displayId}</div>
      )}
      {error && <div className="detail-error">{error}</div>}
      <div className="detail-body">
        <textarea
          ref={textareaRef}
          className="detail-editor"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
        <AutocompletePopup
          items={completionItems}
          selectedIndex={selectedIndex}
          top={popupPos.top}
          left={popupPos.left}
          onSelect={applyCompletion}
        />
      </div>
    </div>
  );
}
