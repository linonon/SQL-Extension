import { useCallback, useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  readonly label: string;
  readonly disabled?: boolean;
  readonly action?: () => void;
  readonly children?: readonly ContextMenuItem[];
}

interface ContextMenuProps {
  readonly items: readonly ContextMenuItem[];
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击菜单外关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item) => (
        <MenuItem key={item.label} item={item} onClose={onClose} />
      ))}
    </div>
  );
}

interface MenuItemProps {
  readonly item: ContextMenuItem;
  readonly onClose: () => void;
}

function MenuItem({ item, onClose }: MenuItemProps) {
  const [showSub, setShowSub] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const hasChildren = item.children && item.children.length > 0;

  const handleMouseEnter = useCallback(() => {
    clearTimeout(timerRef.current);
    if (hasChildren) setShowSub(true);
  }, [hasChildren]);

  const handleMouseLeave = useCallback(() => {
    timerRef.current = setTimeout(() => setShowSub(false), 150);
  }, []);

  const handleClick = useCallback(() => {
    if (item.disabled) return;
    if (item.action) {
      item.action();
      onClose();
    }
  }, [item, onClose]);

  const className = [
    'context-menu-item',
    item.disabled ? 'disabled' : '',
    hasChildren ? 'has-children' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={className}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span>{item.label}</span>
      {hasChildren && <span className="context-menu-arrow">&#9656;</span>}
      {hasChildren && showSub && (
        <div className="context-menu context-menu-submenu">
          {item.children!.map((child) => (
            <MenuItem key={child.label} item={child} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}
