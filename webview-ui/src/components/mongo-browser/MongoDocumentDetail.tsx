import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useMongoAutocomplete } from '../../hooks/useMongoAutocomplete';
import { stripShellTypes, jsonToShell } from '../../utils/mongo-shell-to-json';
import { convertShellToJson, parseShellJson } from '../../../../src/utils/mongo-shell-syntax';
import { jsonErrorLine, validateEjsonValues, lineOfIndex } from './mongo-editor-syntax';
import { findMatches } from '../../utils/text-search';
import { AutocompletePopup } from '../sql-editor/AutocompletePopup';
import { HighlightEditor, isLargeText } from './HighlightEditor';
import { idToShell } from './mongo-id';
import { convertTags } from './mongo-field-editor';

type DetailMode = 'edit' | 'insert';

interface MongoDocumentDetailProps {
  readonly document: Record<string, unknown> | null;
  readonly mode: DetailMode;
  readonly fieldNames: readonly string[];
  readonly onClose: () => void;
  // original: 编辑器打开时的文档 (新建空白文档时为 null); doc: 编辑结果. 都是 EJSON
  readonly onSave: (original: Record<string, unknown> | null, doc: Record<string, unknown>) => void;
  // id: 文档 _id 的 EJSON 值
  readonly onDelete: (id: unknown) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onSaveError?: () => void;
  readonly saveSignal?: number;
}

function stripId(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id, ...rest } = doc;
  return rest;
}

interface Validation {
  readonly ok: boolean;
  readonly error: string;
  // 出错的行号 (1-based), 定位不到时为 null
  readonly line: number | null;
}

const VALID: Validation = { ok: true, error: '', line: null };

// JSON 语法 + EJSON 值合法性 (如 ISODate 里的日期是否真有效). 防止非法值静默写库 (非法日期会变 epoch 0)
function validate(text: string): Validation {
  let parsed: unknown;
  try {
    parsed = parseShellJson(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid JSON';
    return { ok: false, error: msg, line: jsonErrorLine(text, msg) };
  }
  const problem = validateEjsonValues(parsed);
  if (problem) {
    const idx = text.indexOf(problem.value);
    return { ok: false, error: problem.message, line: idx >= 0 ? lineOfIndex(text, idx) : null };
  }
  return VALID;
}

export function MongoDocumentDetail({ document, mode, fieldNames, onClose, onSave, onDelete, onDirtyChange, onSaveError, saveSignal }: MongoDocumentDetailProps) {
  const docId = document ? idToShell(document._id) : '';
  // edit: _id 单列只读, body 去掉 _id; insert(含 clone seed): 保留 _id 让其可编辑.
  // 取打开编辑器那一刻的文档 (空白新建为 null): 编辑内容与保存时的对比基准都以它为准, 期间列表刷新不改基准
  const [openedText] = useState(
    () => document ? jsonToShell(JSON.stringify(mode === 'edit' ? stripId(document) : document, null, 2)) : null
  );
  const initialText = openedText ?? '{}';

  const [text, setText] = useState(initialText);
  const [toast, setToast] = useState('');
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  const dirty = text !== initialText;

  // 校验结果驱动 Save 可用性 + 错误条 + gutter 标红行. 小文档每键实时校验;
  // 大文档 (HighlightEditor 走 plain textarea) 整篇解析每键数百 ms, 只在 Save 时校验, 结果保留到下次改动
  const large = isLargeText(text);
  const liveValidation = useMemo(() => (large ? VALID : validate(text)), [text, large]);
  const [saveValidation, setSaveValidation] = useState<Validation | null>(null);
  const validation = saveValidation ?? liveValidation;

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
  } = useMongoAutocomplete({ fieldNames, value: text, onChange: setText, requirePrefix: true });

  // onChange: 透传原始 event 给 autocomplete hook, 同时更新 local state
  const handleEditorChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setSaveValidation(null);
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

  // Ctrl+F 打开自制搜索条; 大文档没有搜索高亮层, 不拦截, 交给 VS Code 的页内查找.
  // stopPropagation: VS Code 在 webview 的 window 上监听 keydown 并无视 preventDefault 转发给宿主, 不拦会同时弹出它的查找框
  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!large && (e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
    }
  }, [large, openSearch]);

  // wrap autocomplete handleKeyDown: add Ctrl+F to open search
  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!large && (e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
      return;
    }
    autocompleteHandleKeyDown(e);
  }, [large, openSearch, autocompleteHandleKeyDown]);

  const handleSave = useCallback(() => {
    // saveSignal 触发的保存绕过了禁用的 Save 按钮, 须在此复用同一校验闸 (JSON 语法 + EJSON 值合法性),
    // 否则非法值 (如越界整数 / 非法日期) 可经外部保存信号静默写库. 大文档的校验只在这里做.
    const checked = large ? validate(text) : validation;
    if (!checked.ok) { setSaveValidation(checked); onSaveError?.(); return; }
    try {
      const parsed = parseShellJson(text) as Record<string, unknown>;
      // 打开时的文本与编辑结果走同一解析, 没动过的字段两边逐字相同, 宿主按 path 对比后只写改动
      const original = openedText !== null ? parseShellJson(openedText) as Record<string, unknown> : null;
      onSave(original, parsed);
    } catch {
      onSaveError?.();
    }
  }, [text, openedText, onSave, onSaveError, validation, large]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (saveSignal) { handleSave(); } }, [saveSignal]);

  const handleDelete = useCallback(() => {
    onDelete(convertTags(document?._id));
  }, [document, onDelete]);

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
          {/* 工具组: 非破坏性 */}
          <div className="detail-tool-group">
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
            {!large && <button className="btn-small" onClick={openSearch} title="Search (Ctrl+F)">Find</button>}
          </div>
          <span className="detail-action-spacer" style={{ flex: 1 }} />
          {dirty && <span className="detail-dirty-dot" title="未保存的修改">● Unsaved</span>}
          {/* 主操作组: Save/Cancel 成一组 (Delete 在底部隔离) */}
          <div className="detail-primary-group">
            <button className="btn-small" onClick={onClose}>Cancel</button>
            <button
              className="btn-small btn-primary"
              onClick={handleSave}
              disabled={(!dirty && mode === 'edit') || !validation.ok}
              title={!validation.ok ? 'JSON 无效, 无法保存' : undefined}
            >
              Save
            </button>
          </div>
        </div>
      </div>
      {mode === 'edit' && docId && (
        <div className="detail-id-bar">
          <span className="detail-id-label">_id:</span>
          <span className="detail-id-value">{docId}</span>
          <span className="detail-id-readonly" title="_id 不可改; 如需更名请用 Clone">read-only</span>
          <button
            className="btn-small detail-id-copy"
            title="Copy _id"
            onClick={() => { navigator.clipboard.writeText(docId); showToast('Copied _id'); }}
          >
            Copy _id
          </button>
        </div>
      )}
      {!validation.ok && (
        <div className="detail-error">
          ✕ Invalid JSON{validation.line != null ? ` — line ${validation.line}` : ''}: {validation.error}
        </div>
      )}
      {showSearch && !large && (
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
          errorLine={validation.ok ? null : validation.line}
        />
        <AutocompletePopup
          items={completionItems}
          selectedIndex={selectedIndex}
          top={popupPos.top}
          left={popupPos.left}
          onSelect={applyCompletion}
        />
      </div>
      {mode === 'edit' && (
        <div className="detail-footer">
          <button className="btn-small btn-danger detail-delete-btn" onClick={handleDelete}>Delete document</button>
        </div>
      )}
    </div>
  );
}
