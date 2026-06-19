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

  // 包装 onChange: 在 React 重置受控 input 的 DOM value 之前, 快照 target 属性
  // 这样调用方读到的 e.target.value / e.target.selectionStart 都是事件触发时的值
  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const node = e.target;
    const snapshot = {
      value: node.value,
      selectionStart: node.selectionStart,
      selectionEnd: node.selectionEnd,
    };
    const proxied = Object.create(e, {
      target: { value: { ...node, ...snapshot } },
    });
    onChange(proxied as ChangeEvent<HTMLTextAreaElement>);
  }, [onChange]);

  // 编辑器自适应内容高度: backdrop 在普通流中决定高度, textarea 绝对覆盖.
  // 滚动由外层容器 (detail-body) 承担, 故把命中项滚到可视区用 scrollIntoView
  // (会滚动最近的可滚动祖先), 而非手动操作 backdrop.scrollTop.
  useEffect(() => {
    if (activeMatchIndex < 0 || activeMatchIndex >= matches.length) { return; }
    const mark = backdropRef.current?.querySelectorAll('mark')[activeMatchIndex] as HTMLElement | undefined;
    mark?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [activeMatchIndex, matches.length]);

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
