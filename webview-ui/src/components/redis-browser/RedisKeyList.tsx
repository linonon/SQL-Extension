import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RedisKeyInfo } from '../../types/redis';
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu';
import { buildKeyTree, filterKeysFuzzy, type KeyTreeNode } from '../../utils/redis-keys';

interface RedisKeyListProps {
  readonly keys: readonly RedisKeyInfo[];
  readonly selectedKey: string | null;
  readonly hasMore: boolean;
  readonly filterQuery: string;
  readonly onSelectKey: (key: string) => void;
  readonly onLoadMore: () => void;
  readonly onDeleteKey: (key: string) => void;
  readonly onSetTTL: (key: string) => void;
  readonly onExportKey: (key: string) => void;
}

function TypeBadge({ type }: { readonly type: string }) {
  return <span className={`type-badge ${type}`}>{type}</span>;
}

function formatTTL(ttl: number): string {
  if (ttl === -1) { return ''; }
  if (ttl === -2) { return 'expired'; }
  if (ttl < 60) { return `${ttl}s`; }
  if (ttl < 3600) { return `${Math.floor(ttl / 60)}m`; }
  if (ttl < 86400) { return `${Math.floor(ttl / 3600)}h`; }
  return `${Math.floor(ttl / 86400)}d`;
}

interface KeyItemProps {
  readonly keyInfo: RedisKeyInfo;
  readonly selected: boolean;
  readonly displayName: string;
  readonly depth: number;
  readonly onSelect: (key: string) => void;
  readonly onContextMenu: (e: React.MouseEvent, key: string) => void;
}

function KeyItem({ keyInfo, selected, displayName, depth, onSelect, onContextMenu }: KeyItemProps) {
  return (
    <div
      className={`redis-key-item${selected ? ' selected' : ''}`}
      style={{ paddingLeft: depth * 12 + 12 }}
      onClick={() => onSelect(keyInfo.key)}
      onContextMenu={(e) => onContextMenu(e, keyInfo.key)}
    >
      <TypeBadge type={keyInfo.type} />
      <span className="key-name">{displayName}</span>
      {keyInfo.ttl >= 0 && <span className="key-ttl">{formatTTL(keyInfo.ttl)}</span>}
    </div>
  );
}

interface TreeNodeProps {
  readonly node: KeyTreeNode;
  readonly depth: number;
  readonly collapsedGroups: ReadonlySet<string>;
  readonly onToggle: (prefix: string) => void;
  readonly selectedKey: string | null;
  readonly onSelectKey: (key: string) => void;
  readonly onContextMenu: (e: React.MouseEvent, key: string) => void;
}

function TreeNode({ node, depth, collapsedGroups, onToggle, selectedKey, onSelectKey, onContextMenu }: TreeNodeProps) {
  const collapsed = collapsedGroups.has(node.fullPrefix);
  return (
    <div>
      <div
        className="redis-key-group"
        style={{ paddingLeft: depth * 12 + 12 }}
        onClick={() => onToggle(node.fullPrefix)}
      >
        <span className="group-chevron">{collapsed ? '\u25b6' : '\u25bc'}</span>
        <span className="group-name">{node.segment}</span>
        <span className="group-count">{node.totalCount}</span>
      </div>
      {!collapsed && (
        <>
          {node.children.map((child) => (
            <TreeNode
              key={child.fullPrefix}
              node={child}
              depth={depth + 1}
              collapsedGroups={collapsedGroups}
              onToggle={onToggle}
              selectedKey={selectedKey}
              onSelectKey={onSelectKey}
              onContextMenu={onContextMenu}
            />
          ))}
          {node.leafKeys.map((k) => (
            <KeyItem
              key={k.key}
              keyInfo={k}
              selected={selectedKey === k.key}
              displayName={k.key}
              depth={depth + 1}
              onSelect={onSelectKey}
              onContextMenu={onContextMenu}
            />
          ))}
        </>
      )}
    </div>
  );
}

export function RedisKeyList({
  keys,
  selectedKey,
  hasMore,
  filterQuery,
  onSelectKey,
  onLoadMore,
  onDeleteKey,
  onSetTTL,
  onExportKey,
}: RedisKeyListProps) {
  const [contextMenu, setContextMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly key: string;
  } | null>(null);

  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [filterQuery]);

  const filtered = useMemo(() => filterKeysFuzzy(keys, filterQuery), [keys, filterQuery]);
  const tree = useMemo(() => buildKeyTree(filtered), [filtered]);

  const isFiltering = filterQuery.trim() !== '';

  const toggleGroup = useCallback((prefix: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, key });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const contextMenuItems: readonly ContextMenuItem[] = contextMenu
    ? [
        {
          label: 'Export',
          action: () => onExportKey(contextMenu.key),
        },
        {
          label: 'Set TTL',
          action: () => onSetTTL(contextMenu.key),
        },
        {
          label: 'Delete',
          action: () => onDeleteKey(contextMenu.key),
        },
      ]
    : [];

  const isEmpty = keys.length === 0;
  const noMatch = !isEmpty && filtered.length === 0;

  return (
    <>
      <div className="redis-key-list">
        {isEmpty && (
          <div className="redis-empty">No keys found</div>
        )}
        {noMatch && (
          <div className="redis-empty">No matching keys</div>
        )}
        {isFiltering
          ? filtered.map((k) => (
              <KeyItem
                key={k.key}
                keyInfo={k}
                selected={selectedKey === k.key}
                displayName={k.key}
                depth={0}
                onSelect={onSelectKey}
                onContextMenu={handleContextMenu}
              />
            ))
          : (
            <>
              {tree.children.map((node) => (
                <TreeNode
                  key={node.fullPrefix}
                  node={node}
                  depth={0}
                  collapsedGroups={collapsedGroups}
                  onToggle={toggleGroup}
                  selectedKey={selectedKey}
                  onSelectKey={onSelectKey}
                  onContextMenu={handleContextMenu}
                />
              ))}
              {tree.leafKeys.map((k) => (
                <KeyItem
                  key={k.key}
                  keyInfo={k}
                  selected={selectedKey === k.key}
                  displayName={k.key}
                  depth={0}
                  onSelect={onSelectKey}
                  onContextMenu={handleContextMenu}
                />
              ))}
            </>
          )
        }
        {hasMore && (
          <div className="redis-load-more">
            <button className="secondary" onClick={onLoadMore}>
              Load More
            </button>
          </div>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={closeContextMenu}
        />
      )}
    </>
  );
}
