import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RedisValueViewer } from './RedisValueViewer';
import type { RedisValue } from '../../../../src/types/redis';
import { ReadOnlyContext } from '../../hooks/useReadOnly';

// mock 子编辑器
vi.mock('./RedisStringEditor', () => ({
  RedisStringEditor: ({ value }: any) => <div data-testid="string-editor">{value}</div>,
}));

vi.mock('./RedisHashEditor', () => ({
  RedisHashEditor: () => <div data-testid="hash-editor" />,
}));

vi.mock('./RedisListEditor', () => ({
  RedisListEditor: () => <div data-testid="list-editor" />,
}));

vi.mock('./RedisSetEditor', () => ({
  RedisSetEditor: () => <div data-testid="set-editor" />,
}));

vi.mock('./RedisSortedSetEditor', () => ({
  RedisSortedSetEditor: () => <div data-testid="zset-editor" />,
}));

describe('RedisValueViewer', () => {
  const defaultProps = {
    keyName: '',
    keyType: 'string' as const,
    ttl: -1,
    value: null as RedisValue | null,
    commandOutput: null,
    onSaveString: vi.fn(),
    onHashBatchEdit: vi.fn(),
    onHashDeleteField: vi.fn(),
    hashDone: false,
    onHashLoadMore: vi.fn(),
    onListPush: vi.fn(),
    onListRemove: vi.fn(),
    onListBatchSet: vi.fn(),
    onListLoadMore: vi.fn(),
    listHasMore: false,
    onSetAdd: vi.fn(),
    onSetRemove: vi.fn(),
    onSetBatchEdit: vi.fn(),
    onSetLoadMore: vi.fn(),
    setHasMore: false,
    onZSetAdd: vi.fn(),
    onZSetRemove: vi.fn(),
    onZSetBatchEdit: vi.fn(),
    onZSetLoadMore: vi.fn(),
    zsetHasMore: false,
    onDeleteKey: vi.fn(),
    onSetTTL: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('value 为 null 显示选择提示', () => {
    render(<RedisValueViewer {...defaultProps} />);
    expect(screen.getByText('Select a key to view its value')).toBeInTheDocument();
  });

  it('string 类型路由到 RedisStringEditor', () => {
    const value: RedisValue = { type: 'string', value: 'hello' };
    render(<RedisValueViewer {...defaultProps} keyName="k" value={value} />);
    expect(screen.getByTestId('string-editor')).toBeInTheDocument();
  });

  it('hash 类型路由到 RedisHashEditor', () => {
    const value: RedisValue = { type: 'hash', value: { f: 'v' }, cursor: '0' };
    render(<RedisValueViewer {...defaultProps} keyName="k" keyType="hash" value={value} />);
    expect(screen.getByTestId('hash-editor')).toBeInTheDocument();
  });

  it('list 类型路由到 RedisListEditor', () => {
    const value: RedisValue = { type: 'list', value: ['a'], total: 1, start: 0 };
    render(<RedisValueViewer {...defaultProps} keyName="k" keyType="list" value={value} />);
    expect(screen.getByTestId('list-editor')).toBeInTheDocument();
  });

  it('set 类型路由到 RedisSetEditor', () => {
    const value: RedisValue = { type: 'set', value: ['m'], cursor: '0' };
    render(<RedisValueViewer {...defaultProps} keyName="k" keyType="set" value={value} />);
    expect(screen.getByTestId('set-editor')).toBeInTheDocument();
  });

  it('zset 类型路由到 RedisSortedSetEditor', () => {
    const value: RedisValue = { type: 'zset', value: [{ member: 'm', score: 1 }], total: 1, start: 0 };
    render(<RedisValueViewer {...defaultProps} keyName="k" keyType="zset" value={value} />);
    expect(screen.getByTestId('zset-editor')).toBeInTheDocument();
  });

  it('不支持编辑的类型 (模块类型 / stream) 只读显示 TYPE 原名与 CLI 提示, 不给编辑器和 Save', () => {
    const value: RedisValue = { type: 'unsupported', typeName: 'ReJSON-RL' };
    render(<RedisValueViewer {...defaultProps} keyName="j" keyType="unknown" value={value} />);

    expect(screen.getByText('ReJSON-RL')).toBeInTheDocument();
    expect(screen.getByText(/read-only here\. Use the command bar/)).toBeInTheDocument();
    expect(screen.queryByTestId('string-editor')).not.toBeInTheDocument();
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('key info 显示 keyName, keyType, TTL', () => {
    const value: RedisValue = { type: 'string', value: 'test' };
    render(<RedisValueViewer {...defaultProps} keyName="mykey" keyType="string" ttl={300} value={value} />);

    expect(screen.getByText('mykey')).toBeInTheDocument();
    expect(screen.getByText('string')).toBeInTheDocument();
    expect(screen.getByText('TTL: 5m 0s')).toBeInTheDocument();
  });

  it('只读连接不给 Set TTL / Delete', () => {
    const value: RedisValue = { type: 'string', value: 'v' };
    render(<ReadOnlyContext.Provider value={true}><RedisValueViewer {...defaultProps} keyName="k" value={value} /></ReadOnlyContext.Provider>);
    expect(screen.queryByText('Set TTL')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('TTL -1 显示 No expiry', () => {
    const value: RedisValue = { type: 'string', value: '' };
    render(<RedisValueViewer {...defaultProps} keyName="k" ttl={-1} value={value} />);

    expect(screen.getByText('TTL: No expiry')).toBeInTheDocument();
  });
});
