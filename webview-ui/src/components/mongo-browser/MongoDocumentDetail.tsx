import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useMongoAutocomplete } from '../../hooks/useMongoAutocomplete';
import { convertShellToJson, stripShellTypes, jsonToShell } from '../../utils/mongo-shell-to-json';
import { findMatches } from '../../utils/text-search';
import { AutocompletePopup } from '../sql-editor/AutocompletePopup';
import { HighlightEditor } from './HighlightEditor';

type DetailMode = 'edit' | 'insert';

interface MongoDocumentDetailProps {
  readonly document: Record<string, unknown> | null;
  readonly mode: DetailMode;
  readonly fieldNames: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (id: string | null, doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly saveSignal?: number;
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

export function MongoDocumentDetail({ document, mode, fieldNames, onClose, onSave, onDelete, onDirtyChange, saveSignal }: MongoDocumentDetailProps) {
  const displayId = document ? String(document._id ?? '') : '';
  const docId = extractRawId(displayId);
  const initialText = useMemo(
    () => document ? jsonToShell(JSON.stringify(stripId(document), null, 2)) : '{}',
    [document]
  );

  const [text, setText] = useState(initialText);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  const dirty = text !== initialText;

  // search state
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => findMatches(text, searchQuery), [text, searchQuery]);

  // clamp activeMatchIndex when matches change
  useEffect(() => {
    if (matches.length === 0) {
      setActiveMatchIndex(0);
    } else if (activeMatchIndex >= matches.length) {
      setActiveMatchIndex(matches.length - 1);
    }
  }, [matches.length, activeMatchIndex]);

  const {
    textareaRef, completionItems, selectedIndex, popupPos,
    handleChange: autocompleteHandleChange, handleKeyDown: autocompleteHandleKeyDown, applyCompletion,
  } = useMongoAutocomplete({ fieldNames, value: text, onChange: setText });

  // onChange: 透传原始 event 给 autocomplete hook, 同时更新 local state
  const handleEditorChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    autocompleteHandleChange(e);
  }, [autocompleteHandleChange]);

  const openSearch = useCallback(() => {
    setShowSearch(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
    setActiveMatchIndex(0);
  }, []);

  const goNextMatch = useCallback(() => {
    if (matches.length === 0) { return; }
    setActiveMatchIndex(i => (i + 1) % matches.length);
  }, [matches.length]);

  const goPrevMatch = useCallback(() => {
    if (matches.length === 0) { return; }
    setActiveMatchIndex(i => (i - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) { goPrevMatch(); } else { goNextMatch(); }
    }
  }, [closeSearch, goNextMatch, goPrevMatch]);

  // intercept Ctrl+F on the detail container
  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
    }
  }, [openSearch]);

  // wrap autocomplete handleKeyDown: add Ctrl+F to open search
  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
      return;
    }
    autocompleteHandleKeyDown(e);
  }, [openSearch, autocompleteHandleKeyDown]);

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

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (saveSignal) { handleSave(); } }, [saveSignal]);

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
    setShowCopyMenu(false);
  }, [text, showToast]);

  const handleCopyEjson = useCallback(() => {
    navigator.clipboard.writeText(convertShellToJson(text));
    showToast('Copied as EJSON');
    setShowCopyMenu(false);
  }, [text, showToast]);

  const handleCopyJson = useCallback(() => {
    navigator.clipboard.writeText(stripShellTypes(text));
    showToast('Copied as JSON');
    setShowCopyMenu(false);
  }, [text, showToast]);

  // 点击外部关闭 copy menu
  useEffect(() => {
    if (!showCopyMenu) { return; }
    const handleClickOutside = (e: MouseEvent) => {
      if (copyMenuRef.current && !copyMenuRef.current.contains(e.target as Node)) {
        setShowCopyMenu(false);
      }
    };
    window.document.addEventListener('mousedown', handleClickOutside);
    return () => window.document.removeEventListener('mousedown', handleClickOutside);
  }, [showCopyMenu]);

  return (
    <div className="mongo-document-detail" onKeyDown={handleContainerKeyDown}>
      <div className="detail-header">
        <h3>{mode === 'edit' ? 'Edit Document' : 'New Document'}</h3>
        <div className="detail-header-actions">
          <div className="detail-copy-group" ref={copyMenuRef}>
            <button className="btn-small" onClick={() => setShowCopyMenu(v => !v)}>Copy as...</button>
            {showCopyMenu && (
              <div className="detail-copy-menu">
                <button className="detail-copy-menu-item" onClick={handleCopyShell}>Shell</button>
                <button className="detail-copy-menu-item" onClick={handleCopyEjson}>EJSON</button>
                <button className="detail-copy-menu-item" onClick={handleCopyJson}>JSON</button>
              </div>
            )}
            {toast && (
              <span className="detail-copy-toast" onAnimationEnd={() => setToast('')}>{toast}</span>
            )}
          </div>
          <button className="btn-small" onClick={openSearch} title="Search (Ctrl+F)">Find</button>
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
      {showSearch && (
        <div className="detail-search-bar">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setActiveMatchIndex(0); }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search..."
          />
          <span className="search-count">
            {searchQuery ? `${matches.length > 0 ? activeMatchIndex + 1 : 0} / ${matches.length}` : ''}
          </span>
          <button className="btn-small" onClick={goPrevMatch} disabled={matches.length === 0} title="Previous (Shift+Enter)">Prev</button>
          <button className="btn-small" onClick={goNextMatch} disabled={matches.length === 0} title="Next (Enter)">Next</button>
          <button className="btn-small" onClick={closeSearch} title="Close (Esc)">X</button>
        </div>
      )}
      <div className="detail-body">
        <HighlightEditor
          value={text}
          onChange={handleEditorChange}
          onKeyDown={handleEditorKeyDown}
          searchQuery={showSearch ? searchQuery : ''}
          activeMatchIndex={activeMatchIndex}
          textareaRef={textareaRef}
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
