import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { tokenize } from './sql-tokenizer';
import { getAutocompleteContext, getCompletionItems } from './autocomplete';
import { AutocompletePopup } from './AutocompletePopup';
import type { SqlWarning } from '../../utils/sql-linter';
import './sql-editor.css';

interface SqlEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly schema: Record<string, string[]>;
  readonly placeholder?: string;
  readonly onExecute?: () => void;
  readonly onFormat?: () => void;
  readonly warnings?: readonly SqlWarning[];
}

// 测量 monospace 字符宽度
function measureCharWidth(font: string, size: string): number {
  const span = document.createElement('span');
  span.style.font = `${size} ${font}`;
  span.style.position = 'absolute';
  span.style.visibility = 'hidden';
  span.style.whiteSpace = 'pre';
  span.textContent = 'M';
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  document.body.removeChild(span);
  return width;
}

function isInWarningRange(
  tokenStart: number,
  tokenEnd: number,
  warnings: readonly SqlWarning[],
): boolean {
  return warnings.some((w) => tokenStart < w.to && tokenEnd > w.from);
}

export function SqlEditor({
  value,
  onChange,
  schema,
  placeholder,
  onExecute,
  onFormat,
  warnings = [],
}: SqlEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [completionItems, setCompletionItems] = useState<readonly string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });
  const charWidthRef = useRef<number>(0);

  // mount 时测量字符宽度
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const font = style.getPropertyValue('--vscode-editor-font-family') || 'monospace';
    const size = style.getPropertyValue('--vscode-editor-font-size') || '13px';
    charWidthRef.current = measureCharWidth(font, size);
  }, []);

  // schema 异步加载完成后, 重新评估当前 cursor 位置的补全
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || Object.keys(schema).length === 0) return;
    updateCompletion(value, textarea.selectionStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  // scroll 同步
  const handleScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const highlight = highlightRef.current;
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);

  // 生成高亮 HTML
  const highlightHtml = useMemo(() => {
    if (!value) return '';
    const tokens = tokenize(value);
    return tokens
      .map((t) => {
        const escaped = t.value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        if (t.type === 'whitespace') return escaped;

        const warningClass = isInWarningRange(t.start, t.start + t.value.length, warnings)
          ? ' token-warning'
          : '';

        const warningTitle = warningClass
          ? warnings.find((w) => t.start < w.to && t.start + t.value.length > w.from)?.message ?? ''
          : '';

        return `<span class="token-${t.type}${warningClass}"${warningTitle ? ` title="${warningTitle}"` : ''}>${escaped}</span>`;
      })
      .join('');
  }, [value, warnings]);

  // 行号
  const lineNumbers = useMemo(() => {
    const count = value.split('\n').length;
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [value]);

  // 计算补全 popup 位置 (fixed 定位, 用 viewport 全局坐标)
  const updatePopupPosition = useCallback((cursorPos: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const rect = textarea.getBoundingClientRect();
    const textBefore = value.slice(0, cursorPos);
    const lines = textBefore.split('\n');
    const row = lines.length - 1;
    const col = lines[lines.length - 1].length;
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 19.5;
    const charWidth = charWidthRef.current || 7.8;

    setPopupPos({
      top: rect.top + (row + 1) * lineHeight - textarea.scrollTop,
      left: rect.left + col * charWidth - textarea.scrollLeft,
    });
  }, [value]);

  // 更新补全候选项
  const updateCompletion = useCallback((text: string, cursorPos: number) => {
    const ctx = getAutocompleteContext(text, cursorPos);
    const items = getCompletionItems(ctx, schema);
    setCompletionItems(items);
    setSelectedIndex(0);
    if (items.length > 0) {
      updatePopupPosition(cursorPos);
    }
  }, [schema, updatePopupPosition]);

  // 应用补全项
  const applyCompletion = useCallback((item: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const ctx = getAutocompleteContext(value, cursorPos);
    // quoted 时前导反引号也要吃掉, 因为补全项已包含完整的 `item`
    const prefixLen = ctx.prefix.length + (ctx.quoted ? 1 : 0);
    const before = value.slice(0, cursorPos - prefixLen);
    const after = value.slice(cursorPos);
    const newValue = before + item + after;

    onChange(newValue);
    setCompletionItems([]);

    // 恢复光标位置
    const newCursorPos = cursorPos - prefixLen + item.length;
    requestAnimationFrame(() => {
      textarea.selectionStart = newCursorPos;
      textarea.selectionEnd = newCursorPos;
    });
  }, [value, onChange]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
    updateCompletion(newValue, e.target.selectionStart);
  }, [onChange, updateCompletion]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // popup 可见时拦截导航键
    if (completionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, completionItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyCompletion(completionItems[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCompletionItems([]);
        return;
      }
    }

    // Ctrl/Cmd + Enter -> execute
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onExecute?.();
      return;
    }

    // Shift+Alt+F -> format
    if (e.key === 'f' && e.shiftKey && e.altKey) {
      e.preventDefault();
      onFormat?.();
      return;
    }
  }, [completionItems, selectedIndex, applyCompletion, onExecute, onFormat]);

  // Tab 键支持缩进
  const handleTab = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (completionItems.length > 0) return; // popup 处理了
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = value.slice(0, start) + '  ' + value.slice(end);
      onChange(newValue);
      requestAnimationFrame(() => {
        textarea.selectionStart = start + 2;
        textarea.selectionEnd = start + 2;
      });
    }
  }, [value, onChange, completionItems]);

  // 把 Tab 处理合并到 keyDown
  const combinedKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    handleKeyDown(e);
    if (!e.defaultPrevented) {
      handleTab(e);
    }
  }, [handleKeyDown, handleTab]);

  return (
    <div className="sql-editor">
      <div className="sql-editor-gutter">
        {lineNumbers.map((num) => (
          <div key={num} className="sql-editor-gutter-line">{num}</div>
        ))}
      </div>
      <div className="sql-editor-body" ref={bodyRef}>
        <pre
          ref={highlightRef}
          className="sql-editor-highlight"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: highlightHtml || '&nbsp;' }}
        />
        <textarea
          ref={textareaRef}
          className="sql-editor-input"
          value={value}
          onChange={handleChange}
          onKeyDown={combinedKeyDown}
          onScroll={handleScroll}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          data-testid="sql-editor"
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
