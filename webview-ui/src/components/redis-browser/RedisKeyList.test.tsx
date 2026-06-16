import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RedisKeyList } from './RedisKeyList';
import type { RedisKeyInfo } from '../../types/redis';

// mock ContextMenu
vi.mock('../common/ContextMenu', () => ({
  ContextMenu: ({ items, onClose }: any) => (
    <div data-testid="context-menu">
      {items.map((item: any, i: number) => (
        <button key={i} onClick={() => { item.action(); onClose(); }}>{item.label}</button>
      ))}
    </div>
  ),
}));

describe('RedisKeyList', () => {
  const defaultProps = {
    keys: [] as readonly RedisKeyInfo[],
    selectedKey: null as string | null,
    hasMore: false,
    filterQuery: '',
    onSelectKey: vi.fn(),
    onLoadMore: vi.fn(),
    onDeleteKey: vi.fn(),
    onSetTTL: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空列表显示 "No keys found"', () => {
    render(<RedisKeyList {...defaultProps} />);
    expect(screen.getByText('No keys found')).toBeInTheDocument();
  });

  it('渲染 key 列表', () => {
    const keys: RedisKeyInfo[] = [
      { key: 'user:1', type: 'hash', ttl: 300 },
      { key: 'session:abc', type: 'string', ttl: -1 },
    ];
    render(<RedisKeyList {...defaultProps} keys={keys} />);

    expect(screen.getByText('user:1')).toBeInTheDocument();
    expect(screen.getByText('session:abc')).toBeInTheDocument();
  });

  it('点击 key 调用 onSelectKey', () => {
    const keys: RedisKeyInfo[] = [{ key: 'k1', type: 'string', ttl: -1 }];
    render(<RedisKeyList {...defaultProps} keys={keys} />);

    fireEvent.click(screen.getByText('k1'));

    expect(defaultProps.onSelectKey).toHaveBeenCalledWith('k1');
  });

  it('hasMore=true 显示 Load More 按钮', () => {
    const keys: RedisKeyInfo[] = [{ key: 'k1', type: 'string', ttl: -1 }];
    render(<RedisKeyList {...defaultProps} keys={keys} hasMore={true} />);

    expect(screen.getByText('Load More')).toBeInTheDocument();
  });

  it('hasMore=false 不显示 Load More', () => {
    const keys: RedisKeyInfo[] = [{ key: 'k1', type: 'string', ttl: -1 }];
    render(<RedisKeyList {...defaultProps} keys={keys} hasMore={false} />);

    expect(screen.queryByText('Load More')).not.toBeInTheDocument();
  });

  it('Load More 按钮调用 onLoadMore', () => {
    const keys: RedisKeyInfo[] = [{ key: 'k1', type: 'string', ttl: -1 }];
    render(<RedisKeyList {...defaultProps} keys={keys} hasMore={true} />);

    fireEvent.click(screen.getByText('Load More'));

    expect(defaultProps.onLoadMore).toHaveBeenCalled();
  });

  it('右键菜单 Delete 调用 onDeleteKey', () => {
    const keys: RedisKeyInfo[] = [{ key: 'k1', type: 'string', ttl: -1 }];
    render(<RedisKeyList {...defaultProps} keys={keys} />);

    fireEvent.contextMenu(screen.getByText('k1'));
    fireEvent.click(screen.getByText('Delete'));

    expect(defaultProps.onDeleteKey).toHaveBeenCalledWith('k1');
  });

  it('TTL >= 0 显示 TTL', () => {
    const keys: RedisKeyInfo[] = [{ key: 'k1', type: 'string', ttl: 120 }];
    render(<RedisKeyList {...defaultProps} keys={keys} />);

    expect(screen.getByText('2m')).toBeInTheDocument();
  });

  // --- 分组相关测试 ---

  it('同前缀 key >= 2 个时显示分组头', () => {
    const keys: RedisKeyInfo[] = [
      { key: 'user:alice', type: 'string', ttl: -1 },
      { key: 'user:bob', type: 'string', ttl: -1 },
    ];
    render(<RedisKeyList {...defaultProps} keys={keys} />);

    // 树形分组: 组头显示 segment "user", 叶子节点显示完整 key
    expect(screen.getByText('user')).toBeInTheDocument();
    expect(screen.getByText('user:alice')).toBeInTheDocument();
    expect(screen.getByText('user:bob')).toBeInTheDocument();
  });

  it('点击组头可折叠/展开', () => {
    const keys: RedisKeyInfo[] = [
      { key: 'user:1', type: 'string', ttl: -1 },
      { key: 'user:2', type: 'string', ttl: -1 },
    ];
    render(<RedisKeyList {...defaultProps} keys={keys} />);

    // 默认展开, 可以看到子 key
    expect(screen.getByText('user:1')).toBeInTheDocument();

    // 点击组头 (segment "user") 折叠
    fireEvent.click(screen.getByText('user'));
    expect(screen.queryByText('user:1')).not.toBeInTheDocument();

    // 再点击展开
    fireEvent.click(screen.getByText('user'));
    expect(screen.getByText('user:1')).toBeInTheDocument();
  });

  it('显示组内 key 数量', () => {
    const keys: RedisKeyInfo[] = [
      { key: 'user:alice', type: 'string', ttl: -1 },
      { key: 'user:bob', type: 'string', ttl: -1 },
      { key: 'user:charlie', type: 'string', ttl: -1 },
    ];
    const { container } = render(<RedisKeyList {...defaultProps} keys={keys} />);

    const countEl = container.querySelector('.group-count');
    expect(countEl).not.toBeNull();
    expect(countEl!.textContent).toBe('3');
  });

  // --- fuzzy filter 测试 ---

  it('filterQuery 过滤 key', () => {
    const keys: RedisKeyInfo[] = [
      { key: 'user:profile', type: 'string', ttl: -1 },
      { key: 'session:abc', type: 'string', ttl: -1 },
    ];
    render(<RedisKeyList {...defaultProps} keys={keys} filterQuery="user" />);

    // user:profile 单个 key, 不成组, 顶层显示完整 key 名
    expect(screen.getByText('user:profile')).toBeInTheDocument();
    expect(screen.queryByText('session:abc')).not.toBeInTheDocument();
  });

  it('filterQuery 不匹配任何 key 显示 "No matching keys"', () => {
    const keys: RedisKeyInfo[] = [
      { key: 'user:1', type: 'string', ttl: -1 },
    ];
    render(<RedisKeyList {...defaultProps} keys={keys} filterQuery="zzz" />);

    expect(screen.getByText('No matching keys')).toBeInTheDocument();
  });

  it('filter 变化时应重置折叠状态', () => {
    const keys: RedisKeyInfo[] = [
      { key: 'user:1', type: 'string', ttl: -1 },
      { key: 'user:2', type: 'string', ttl: -1 },
    ];
    const { rerender } = render(<RedisKeyList {...defaultProps} keys={keys} filterQuery="" />);

    // 折叠 user 组
    fireEvent.click(screen.getByText('user'));
    expect(screen.queryByText('user:1')).not.toBeInTheDocument();

    // 改变 filterQuery, 折叠状态应重置, 子 key 重新可见
    rerender(<RedisKeyList {...defaultProps} keys={keys} filterQuery="user" />);
    expect(screen.getByText('user:1')).toBeInTheDocument();
  });
});
