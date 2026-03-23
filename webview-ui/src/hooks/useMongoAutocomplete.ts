import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  getMongoAutocompleteContext,
  getMongoCompletionItems,
} from '../components/mongo-browser/mongo-autocomplete';

// 模块级缓存, 只测量一次
let cachedCharWidth: number | null = null;

function getCharWidth(): number {
  if (cachedCharWidth !== null) return cachedCharWidth;
  const style = getComputedStyle(document.documentElement);
  const font = style.getPropertyValue('--vscode-editor-font-family') || 'monospace';
  const size = style.getPropertyValue('--vscode-editor-font-size') || '13px';
  const span = document.createElement('span');
  span.style.cssText = `font: ${size} ${font}; position: absolute; visibility: hidden; white-space: pre`;
  span.textContent = 'M';
  document.body.appendChild(span);
  cachedCharWidth = span.getBoundingClientRect().width;
  document.body.removeChild(span);
  return cachedCharWidth;
}

interface UseMongoAutocompleteOptions {
  readonly fieldNames: readonly string[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onApply?: () => void;
  // true: 只在有 prefix 时触发补全 (edit document 场景)
  // false/undefined: 空 prefix 也触发, 显示所有候选 (filter input 场景)
  readonly requirePrefix?: boolean;
}

interface UseMongoAutocompleteResult {
  readonly textareaRef: RefObject<HTMLTextAreaElement>;
  readonly completionItems: readonly string[];
  readonly selectedIndex: number;
  readonly popupPos: { readonly top: number; readonly left: number };
  readonly handleChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly applyCompletion: (item: string) => void;
}

export function useMongoAutocomplete({
  fieldNames,
  value,
  onChange,
  onApply,
  requirePrefix = false,
}: UseMongoAutocompleteOptions): UseMongoAutocompleteResult {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPosRef = useRef<number>(0);
  const valueRef = useRef(value);
  const [completionItems, setCompletionItems] = useState<readonly string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });
  const charWidthRef = useRef<number>(0);

  useEffect(() => { valueRef.current = value; });

  useEffect(() => {
    charWidthRef.current = getCharWidth();
  }, []);

  const updatePopupPosition = useCallback((cursorPos: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const rect = textarea.getBoundingClientRect();
    const textBefore = valueRef.current.slice(0, cursorPos);
    const lines = textBefore.split('\n');
    const col = lines[lines.length - 1].length;
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24;
    const charWidth = charWidthRef.current || 7.8;
    setPopupPos({
      top: rect.top + lineHeight,
      left: rect.left + col * charWidth - textarea.scrollLeft,
    });
  }, []);

  const updateCompletion = useCallback((text: string, cursorPos: number) => {
    const ctx = getMongoAutocompleteContext(text, cursorPos);
    // requirePrefix 模式: prefix 为空时不弹出补全
    if (requirePrefix && ctx.prefix === '') {
      setCompletionItems([]);
      return;
    }
    const items = getMongoCompletionItems(ctx, fieldNames);
    setCompletionItems(items);
    setSelectedIndex(0);
    if (items.length > 0) {
      updatePopupPosition(cursorPos);
    }
  }, [fieldNames, requirePrefix, updatePopupPosition]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || fieldNames.length === 0) return;
    updateCompletion(valueRef.current, textarea.selectionStart);
  }, [fieldNames, updateCompletion]);

  const applyCompletion = useCallback((item: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = cursorPosRef.current;
    const currentValue = valueRef.current;
    const ctx = getMongoAutocompleteContext(currentValue, cursorPos);
    const prefixLen = ctx.prefix.length;
    const insertStart = cursorPos - prefixLen;

    // 根据引号上下文适配插入内容
    let insertion = item;
    let cursorBack = 0;
    if (ctx.triggerType === 'function') {
      const NO_ARG_FUNCTIONS = new Set(['MinKey', 'MaxKey']);
      insertion = NO_ARG_FUNCTIONS.has(item) ? item + '()' : item + '("")';
      cursorBack = NO_ARG_FUNCTIONS.has(item) ? 0 : 2;
    } else if (ctx.triggerType === 'field' || ctx.triggerType === 'operator') {
      const charBefore = insertStart > 0 ? currentValue[insertStart - 1] : '';
      if (charBefore === '"') {
        insertion = item + '": ';
      } else if (charBefore === "'") {
        insertion = item + "': ";
      } else {
        insertion = '"' + item + '": ';
      }
    }

    // 用 execCommand 插入, 保持浏览器原生 undo 栈
    textarea.focus();
    textarea.selectionStart = insertStart;
    textarea.selectionEnd = cursorPos;
    document.execCommand('insertText', false, insertion);

    setCompletionItems([]);
    const newCursorPos = insertStart + insertion.length - cursorBack;
    cursorPosRef.current = newCursorPos;
    if (cursorBack > 0) {
      requestAnimationFrame(() => {
        textarea.selectionStart = newCursorPos;
        textarea.selectionEnd = newCursorPos;
      });
    }
  }, []);

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    cursorPosRef.current = e.target.selectionStart;
    onChange(newValue);
    updateCompletion(newValue, e.target.selectionStart);
  }, [onChange, updateCompletion]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    // 无 popup 时: 有 onApply -> Enter 触发 apply; 无 onApply -> Enter 换行 (默认行为)
    if (onApply && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onApply();
    }
  }, [completionItems, selectedIndex, applyCompletion, onApply]);

  return {
    textareaRef,
    completionItems,
    selectedIndex,
    popupPos,
    handleChange,
    handleKeyDown,
    applyCompletion,
  };
}
