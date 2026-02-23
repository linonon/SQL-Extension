import { useEffect, useRef } from 'react';

interface AutocompletePopupProps {
  readonly items: readonly string[];
  readonly selectedIndex: number;
  readonly top: number;
  readonly left: number;
  readonly onSelect: (item: string) => void;
}

export function AutocompletePopup({
  items,
  selectedIndex,
  top,
  left,
  onSelect,
}: AutocompletePopupProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // 自动滚动到选中项
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <ul
      ref={listRef}
      className="sql-autocomplete"
      style={{ top, left }}
      role="listbox"
    >
      {items.map((item, i) => (
        <li
          key={item}
          className="sql-autocomplete-item"
          data-selected={i === selectedIndex ? 'true' : undefined}
          role="option"
          aria-selected={i === selectedIndex}
          onMouseDown={(e) => {
            e.preventDefault(); // 阻止 textarea blur
            onSelect(item);
          }}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}
