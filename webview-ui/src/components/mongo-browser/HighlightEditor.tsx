import { useCallback, useEffect, useMemo, useRef, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';
import { findMatches } from '../../utils/text-search';
import { tokenizeMongoJson } from './mongo-editor-syntax';

interface HighlightEditorProps {
  readonly value: string;
  // 透传原始 ChangeEvent, 让调用方能读 selectionStart 等 DOM 属性
  readonly onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly searchQuery: string;
  readonly activeMatchIndex: number;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  // 校验失败的行号 (1-based), 在 gutter 标红
  readonly errorLine?: number | null;
}

// 渲染单行的着色 token
function renderLineTokens(line: string): React.ReactNode[] {
  return tokenizeMongoJson(line).map((tok, i) =>
    tok.type === 'plain'
      ? tok.text
      : <span key={i} className={`hl-tok-${tok.type}`}>{tok.text}</span>
  );
}

/**
 * 代码编辑器: 三层对齐叠放.
 * - syntax 层 (普通流, 撑高容器): 行号 gutter + 着色 token, 用户看到的彩色文本.
 * - search 层 (绝对覆盖): 透明文本 + <mark> 命中底色.
 * - textarea (绝对覆盖, 最上): 透明文本 + 可见 caret, 处理编辑.
 * 三层同字体/行高/换行宽度 (textarea/search padding-left = gutter 宽), 故逐行对齐.
 */
export function HighlightEditor({
  value, onChange, onKeyDown, searchQuery, activeMatchIndex, textareaRef: externalRef, errorLine,
}: HighlightEditorProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? internalRef;

  const matches = useMemo(() => findMatches(value, searchQuery), [value, searchQuery]);
  const lines = useMemo(() => value.split('\n'), [value]);
  // gutter 宽度按最大行号位数, 同时给 textarea/search padding-left 用 (经 CSS 变量)
  const gutterVar = { ['--hl-gutter' as string]: `calc(${String(lines.length).length}ch + 16px)` } as React.CSSProperties;

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const node = e.target;
    const snapshot = { value: node.value, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd };
    const proxied = Object.create(e, { target: { value: { ...node, ...snapshot } } });
    onChange(proxied as ChangeEvent<HTMLTextAreaElement>);
  }, [onChange]);

  // 命中项滚入可视区 (外层 detail-body 滚动)
  useEffect(() => {
    if (activeMatchIndex < 0 || activeMatchIndex >= matches.length) { return; }
    const mark = backdropRef.current?.querySelectorAll('mark')[activeMatchIndex] as HTMLElement | undefined;
    mark?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [activeMatchIndex, matches.length]);

  // search 层片段: 透明文本 + 命中 <mark>
  const segments = useMemo(() => {
    if (matches.length === 0) { return [<span key="all">{value + '\n'}</span>]; }
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    matches.forEach((m, i) => {
      if (cursor < m.start) { parts.push(<span key={`t-${i}`}>{value.slice(cursor, m.start)}</span>); }
      parts.push(
        <mark key={`m-${i}`} className={i === activeMatchIndex ? 'highlight-match highlight-active' : 'highlight-match'}>
          {value.slice(m.start, m.end)}
        </mark>
      );
      cursor = m.end;
    });
    if (cursor < value.length) { parts.push(<span key="tail">{value.slice(cursor)}</span>); }
    parts.push(<span key="nl">{'\n'}</span>);
    return parts;
  }, [value, matches, activeMatchIndex]);

  return (
    <div className="highlight-editor-container" style={gutterVar}>
      <div className="highlight-editor-syntax" aria-hidden="true">
        {lines.map((line, idx) => (
          <div className={`hl-row${errorLine === idx + 1 ? ' hl-row-error' : ''}`} key={idx}>
            <span className="hl-ln">{idx + 1}</span>
            <span className="hl-code">{renderLineTokens(line)}</span>
          </div>
        ))}
      </div>
      <div ref={backdropRef} className="highlight-editor-backdrop" aria-hidden="true">
        <div className="highlight-editor-backdrop-inner">{segments}</div>
      </div>
      <textarea
        ref={ref as RefObject<HTMLTextAreaElement>}
        className="highlight-editor-textarea"
        value={value}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        spellCheck={false}
      />
    </div>
  );
}
