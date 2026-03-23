# Mongo Document Editor Search Highlight Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ctrl+F search with real-time text highlighting in the Mongo document editor (MongoDocumentDetail).

**Architecture:** Use the "highlight overlay" technique - a transparent `<textarea>` layered on top of a `<div>` backdrop that mirrors the text with `<mark>` elements for search matches. A search bar appears above the editor when activated via Ctrl+F or a search button. The search bar shows match count and supports next/prev navigation (Enter / Shift+Enter).

**Tech Stack:** React 18, CSS (VS Code theme variables), Vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `webview-ui/src/utils/text-search.ts` | Pure function: find all match ranges in text |
| Create | `webview-ui/src/utils/text-search.test.ts` | Tests for text-search |
| Create | `webview-ui/src/components/mongo-browser/HighlightEditor.tsx` | Composite textarea + backdrop overlay with search highlight |
| Create | `webview-ui/src/components/mongo-browser/HighlightEditor.test.tsx` | Tests for HighlightEditor |
| Modify | `webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx` | Replace plain textarea with HighlightEditor, add search bar |
| Modify | `webview-ui/src/styles/mongo-browser.css` | Add styles for search bar and highlight overlay; fix `.detail-body` overflow |

## Integration Notes

**Critical: `useMongoAutocomplete` hook integration**

`useMongoAutocomplete.handleChange` (line 153-158) reads `e.target.selectionStart` to track cursor position for autocomplete. The `HighlightEditor` must pass the raw `ChangeEvent<HTMLTextAreaElement>` through to preserve this behavior - do NOT construct a fake event object.

The hook creates its own `textareaRef` (line 55, type `RefObject<HTMLTextAreaElement>`) which must be passed to `HighlightEditor` so both the hook and the overlay share the same DOM element.

---

### Task 1: Text Search Utility

**Files:**
- Create: `webview-ui/src/utils/text-search.ts`
- Test: `webview-ui/src/utils/text-search.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// webview-ui/src/utils/text-search.test.ts
import { describe, it, expect } from 'vitest';
import { findMatches, type MatchRange } from './text-search';

describe('findMatches', () => {
  it('returns empty array for empty pattern', () => {
    expect(findMatches('hello world', '')).toEqual([]);
  });

  it('returns empty array when no match', () => {
    expect(findMatches('hello world', 'xyz')).toEqual([]);
  });

  it('finds a single match', () => {
    expect(findMatches('hello world', 'world')).toEqual([
      { start: 6, end: 11 },
    ]);
  });

  it('finds multiple matches', () => {
    expect(findMatches('abcabc', 'abc')).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });

  it('is case-insensitive by default', () => {
    expect(findMatches('Hello HELLO hello', 'hello')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it('supports case-sensitive mode', () => {
    expect(findMatches('Hello HELLO hello', 'hello', true)).toEqual([
      { start: 12, end: 17 },
    ]);
  });

  it('handles overlapping potential matches (non-overlapping result)', () => {
    expect(findMatches('aaa', 'aa')).toEqual([
      { start: 0, end: 2 },
    ]);
  });

  it('returns empty for empty text', () => {
    expect(findMatches('', 'abc')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webview-ui && npx vitest run src/utils/text-search.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// webview-ui/src/utils/text-search.ts
export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 在 text 中查找所有 pattern 的非重叠匹配位置.
 * 默认 case-insensitive.
 */
export function findMatches(text: string, pattern: string, caseSensitive = false): MatchRange[] {
  if (!pattern || !text) { return []; }
  const t = caseSensitive ? text : text.toLowerCase();
  const p = caseSensitive ? pattern : pattern.toLowerCase();
  const results: MatchRange[] = [];
  let pos = 0;
  while (pos <= t.length - p.length) {
    const idx = t.indexOf(p, pos);
    if (idx === -1) { break; }
    results.push({ start: idx, end: idx + p.length });
    pos = idx + p.length; // non-overlapping
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd webview-ui && npx vitest run src/utils/text-search.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/utils/text-search.ts webview-ui/src/utils/text-search.test.ts
git commit -m "feat(mongo): add text search utility for match range detection"
```

---

### Task 2: HighlightEditor Component

This is the core component: a textarea with a synchronized backdrop div that renders highlighted text.

**Key design decisions:**
- `onChange` passes the raw `ChangeEvent<HTMLTextAreaElement>` so callers can access `selectionStart` (required by `useMongoAutocomplete`)
- `textareaRef` prop accepts `RefObject<HTMLTextAreaElement | null>` to share the DOM ref with the autocomplete hook
- Scroll sync uses manual `offsetTop` calculation instead of `scrollIntoView` (which is async and can bubble to parent containers)
- Textarea has explicit `overflow: auto` for consistent cross-browser scrolling

**Files:**
- Create: `webview-ui/src/components/mongo-browser/HighlightEditor.tsx`
- Test: `webview-ui/src/components/mongo-browser/HighlightEditor.test.tsx`

- [ ] **Step 1: Write the failing tests**

```typescript
// webview-ui/src/components/mongo-browser/HighlightEditor.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HighlightEditor } from './HighlightEditor';

describe('HighlightEditor', () => {
  it('renders textarea with provided value', () => {
    render(
      <HighlightEditor
        value='{"name": "test"}'
        onChange={() => {}}
        searchQuery=""
        activeMatchIndex={-1}
      />
    );
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue('{"name": "test"}');
  });

  it('calls onChange with raw event when user types', () => {
    const onChange = vi.fn();
    render(
      <HighlightEditor
        value=""
        onChange={onChange}
        searchQuery=""
        activeMatchIndex={-1}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } });
    expect(onChange).toHaveBeenCalled();
    // onChange receives the raw ChangeEvent
    expect(onChange.mock.calls[0][0].target.value).toBe('new');
  });

  it('renders highlight marks when searchQuery matches', () => {
    const { container } = render(
      <HighlightEditor
        value='hello world hello'
        onChange={() => {}}
        searchQuery="hello"
        activeMatchIndex={0}
      />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
  });

  it('renders no marks when searchQuery is empty', () => {
    const { container } = render(
      <HighlightEditor
        value='hello world'
        onChange={() => {}}
        searchQuery=""
        activeMatchIndex={-1}
      />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(0);
  });

  it('applies active class to the active match', () => {
    const { container } = render(
      <HighlightEditor
        value='aaa bbb aaa'
        onChange={() => {}}
        searchQuery="aaa"
        activeMatchIndex={1}
      />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks[0]).not.toHaveClass('highlight-active');
    expect(marks[1]).toHaveClass('highlight-active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/HighlightEditor.test.tsx`
Expected: FAIL - module not found

- [ ] **Step 3: Write the HighlightEditor component**

```tsx
// webview-ui/src/components/mongo-browser/HighlightEditor.tsx
import { useCallback, useEffect, useMemo, useRef, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';
import { findMatches } from '../../utils/text-search';

interface HighlightEditorProps {
  readonly value: string;
  // 透传原始 ChangeEvent, 让调用方能读 selectionStart 等 DOM 属性
  readonly onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly searchQuery: string;
  readonly activeMatchIndex: number;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Textarea with a synchronized backdrop that highlights search matches.
 * textarea: transparent background, handles editing
 * backdrop div: mirrors text content with <mark> elements for matches
 */
export function HighlightEditor({
  value, onChange, onKeyDown, searchQuery, activeMatchIndex, textareaRef: externalRef,
}: HighlightEditorProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? internalRef;

  const matches = useMemo(() => findMatches(value, searchQuery), [value, searchQuery]);

  // sync scroll position between textarea and backdrop
  const handleScroll = useCallback(() => {
    if (ref.current && backdropRef.current) {
      backdropRef.current.scrollTop = ref.current.scrollTop;
      backdropRef.current.scrollLeft = ref.current.scrollLeft;
    }
  }, [ref]);

  // scroll active match into view via manual offsetTop calculation
  useEffect(() => {
    if (activeMatchIndex < 0 || activeMatchIndex >= matches.length) { return; }
    const mark = backdropRef.current?.querySelectorAll('mark')[activeMatchIndex] as HTMLElement | undefined;
    if (!mark || !backdropRef.current || !ref.current) { return; }
    const markTop = mark.offsetTop;
    const containerHeight = backdropRef.current.clientHeight;
    const scrollTarget = Math.max(0, markTop - containerHeight / 2);
    backdropRef.current.scrollTop = scrollTarget;
    ref.current.scrollTop = scrollTarget;
  }, [activeMatchIndex, matches.length, ref]);

  // build highlighted segments
  const segments = useMemo(() => {
    if (matches.length === 0) {
      // 无匹配时, 追加换行保持 backdrop 高度与 textarea 一致
      return [<span key="all">{value + '\n'}</span>];
    }
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    matches.forEach((m, i) => {
      if (cursor < m.start) {
        parts.push(<span key={`t-${i}`}>{value.slice(cursor, m.start)}</span>);
      }
      parts.push(
        <mark
          key={`m-${i}`}
          className={i === activeMatchIndex ? 'highlight-match highlight-active' : 'highlight-match'}
        >
          {value.slice(m.start, m.end)}
        </mark>
      );
      cursor = m.end;
    });
    if (cursor < value.length) {
      parts.push(<span key="tail">{value.slice(cursor)}</span>);
    }
    parts.push(<span key="nl">{'\n'}</span>);
    return parts;
  }, [value, matches, activeMatchIndex]);

  return (
    <div className="highlight-editor-container">
      <div ref={backdropRef} className="highlight-editor-backdrop" aria-hidden="true">
        <div className="highlight-editor-backdrop-inner">{segments}</div>
      </div>
      <textarea
        ref={ref}
        className="highlight-editor-textarea"
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onScroll={handleScroll}
        spellCheck={false}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/HighlightEditor.test.tsx`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/mongo-browser/HighlightEditor.tsx webview-ui/src/components/mongo-browser/HighlightEditor.test.tsx
git commit -m "feat(mongo): add HighlightEditor with search overlay"
```

---

### Task 3: CSS Styles for Search Bar and Highlight Overlay

**Files:**
- Modify: `webview-ui/src/styles/mongo-browser.css`

- [ ] **Step 1: Fix `.detail-body` to avoid double scrollbar**

Change existing `.detail-body` rule from `overflow: auto; padding: 12px` to `overflow: hidden; padding: 0` so `HighlightEditor` fully manages scrolling and padding internally.

Find at `mongo-browser.css:299-303`:
```css
/* Before */
.mongo-document-detail .detail-body {
  flex: 1;
  overflow: auto;
  padding: 12px;
}
```
Replace with:
```css
/* After */
.mongo-document-detail .detail-body {
  flex: 1;
  overflow: hidden;
  padding: 0;
}
```

- [ ] **Step 2: Append highlight overlay and search bar styles**

Append the following to the end of `mongo-browser.css`:

```css
/* === Search highlight editor === */
.highlight-editor-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.highlight-editor-backdrop {
  position: absolute;
  inset: 0;
  overflow: auto;
  pointer-events: none;
  z-index: 0;
  background: var(--vscode-editor-background);
}

.highlight-editor-backdrop-inner {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 8px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  color: transparent; /* text invisible, only marks visible */
}

.highlight-editor-textarea {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  resize: none;
  border: none;
  outline: none;
  overflow: auto;
  padding: 8px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  color: var(--vscode-editor-foreground);
  background: transparent;
  caret-color: var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground));
}

.highlight-match {
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  border-radius: 2px;
  color: transparent; /* keep text invisible in backdrop */
}

.highlight-active {
  background: var(--vscode-editor-findMatchBackground, rgba(255, 150, 50, 0.6));
  outline: 1px solid var(--vscode-editor-findMatchBorder, #ee7700);
}

/* Search bar in document detail */
.detail-search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  flex-shrink: 0;
}

.detail-search-bar input[type="text"] {
  flex: 1;
  min-width: 120px;
  height: 22px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  padding: 0 6px;
  box-sizing: border-box;
}

.detail-search-bar .search-count {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  min-width: 60px;
  text-align: center;
}

.detail-search-bar .btn-small {
  font-size: 11px;
  padding: 2px 6px;
}
```

- [ ] **Step 3: Build to verify no errors**

Run: `cd webview-ui && npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/styles/mongo-browser.css
git commit -m "style(mongo): add CSS for search bar and highlight overlay"
```

---

### Task 4: Integrate Search into MongoDocumentDetail

**Files:**
- Modify: `webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx`

**Critical integration point:** `useMongoAutocomplete.handleChange` reads `e.target.selectionStart` from the raw `ChangeEvent`. Since `HighlightEditor.onChange` now passes the raw event, we call `autocompleteHandleChange(e)` directly in the `onChange` handler. We also call `setText(e.target.value)` to keep local state in sync.

- [ ] **Step 1: Replace textarea with HighlightEditor and add search bar**

Full replacement of `MongoDocumentDetail.tsx`:

```tsx
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
    <div className="mongo-document-detail" onKeyDown={handleContainerKeyDown}>
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
```

- [ ] **Step 2: Verify autocomplete integration**

Note: `useMongoAutocomplete` has `onChange: setText` in its options, and its `handleChange` (line 153-158) calls `onChange(newValue)` internally. Since we also call `setText(e.target.value)` in `handleEditorChange`, the `setText` will be called twice (once by us, once by the hook). This is safe because React batches state updates within the same event handler, and both calls set the same value. However, to avoid the double-call, we could pass a no-op to the hook's `onChange` option. But this would break `applyCompletion` (line 118, 143) which calls `onChange(newValue)` to update text. So we keep `onChange: setText` and accept the harmless double-call.

- [ ] **Step 3: Build and verify no compile errors**

Run: `cd webview-ui && npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx
git commit -m "feat(mongo): integrate search highlight into document editor"
```

---

### Task 5: Build and Manual Verification

**Files:**
- All modified files

- [ ] **Step 1: Run all tests**

Run: `cd webview-ui && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Build webview**

Run: `cd webview-ui && npm run build`
Expected: Build succeeds, `webview-ui/dist/` updated

- [ ] **Step 3: Build extension host**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Manual test checklist**

1. Open a MongoDB collection, click a document to edit
2. Press Ctrl+F (or Cmd+F on macOS) - search bar appears with focus on input
3. Type a search term - matches highlight in the editor backdrop
4. Press Enter to cycle to next match, Shift+Enter for previous
5. Match count shows "N / M" format
6. Press Escape to close search bar, highlights disappear
7. Click "Find" button in header - same as Ctrl+F
8. Autocomplete still works (type a field name to trigger)
9. Edit text while search is active - highlights update in real-time
10. Scroll the editor - backdrop scrolls in sync

- [ ] **Step 5: Final commit**

```bash
git add webview-ui/src/utils/text-search.ts webview-ui/src/utils/text-search.test.ts \
  webview-ui/src/components/mongo-browser/HighlightEditor.tsx webview-ui/src/components/mongo-browser/HighlightEditor.test.tsx \
  webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx \
  webview-ui/src/styles/mongo-browser.css
git commit -m "feat(mongo): complete search highlight in document editor"
```
