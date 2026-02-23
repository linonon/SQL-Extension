import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { mockPostMessage } from './__test__/setup';
import type { ExtensionMessage } from './types/messages';

// mock 子组件避免依赖问题
vi.mock('./components/data-grid/DataGrid', () => ({
  DataGrid: ({ connectionId, database, table }: { connectionId: string; database: string; table: string }) => (
    <div data-testid="data-grid">
      DataGrid: {connectionId} / {database} / {table}
    </div>
  ),
}));

vi.mock('./components/query-editor/QueryEditor', () => ({
  QueryEditor: ({ connectionId, database }: { connectionId: string; database: string }) => (
    <div data-testid="query-editor">
      QueryEditor: {connectionId} / {database}
    </div>
  ),
}));

vi.mock('./components/connection-form/ConnectionForm', () => ({
  ConnectionForm: () => <div data-testid="connection-form">ConnectionForm</div>,
}));

describe('App', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('应该在挂载后发送 ready 消息', () => {
    render(<App />);

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('应该在未收到 viewInit 时显示 Loading 状态', () => {
    render(<App />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('应该在收到 viewInit 消息后渲染 table 视图', async () => {
    render(<App />);

    const message: ExtensionMessage = {
      type: 'viewInit',
      view: 'table',
      context: {
        connectionId: 'conn-123',
        database: 'test_db',
        table: 'users',
      },
    };

    window.dispatchEvent(new MessageEvent('message', { data: message }));

    await waitFor(() => {
      expect(screen.getByTestId('data-grid')).toBeInTheDocument();
      expect(screen.getByText('DataGrid: conn-123 / test_db / users')).toBeInTheDocument();
    });
  });

  it('应该在收到 viewInit 消息后渲染 query 视图', async () => {
    render(<App />);

    const message: ExtensionMessage = {
      type: 'viewInit',
      view: 'query',
      context: {
        connectionId: 'conn-456',
        database: 'prod_db',
      },
    };

    window.dispatchEvent(new MessageEvent('message', { data: message }));

    await waitFor(() => {
      expect(screen.getByTestId('query-editor')).toBeInTheDocument();
      expect(screen.getByText('QueryEditor: conn-456 / prod_db')).toBeInTheDocument();
    });
  });

  it('应该在收到 viewInit 消息后渲染 connection-form 视图', async () => {
    render(<App />);

    const message: ExtensionMessage = {
      type: 'viewInit',
      view: 'connection-form',
    };

    window.dispatchEvent(new MessageEvent('message', { data: message }));

    await waitFor(() => {
      expect(screen.getByTestId('connection-form')).toBeInTheDocument();
      expect(screen.getByText('ConnectionForm')).toBeInTheDocument();
    });
  });

  it('应该在收到未知 view 类型时显示错误信息', async () => {
    render(<App />);

    const message = {
      type: 'viewInit',
      view: 'unknown-view',
    } as unknown as ExtensionMessage;

    window.dispatchEvent(new MessageEvent('message', { data: message }));

    await waitFor(() => {
      expect(screen.getByText(/Unknown view/)).toBeInTheDocument();
    });
  });

  it('应该忽略非 viewInit 类型的消息', async () => {
    render(<App />);

    const message: ExtensionMessage = {
      type: 'error',
      message: 'Test error',
    };

    window.dispatchEvent(new MessageEvent('message', { data: message }));

    // 应该保持 Loading 状态
    await waitFor(() => {
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });
  });

  it('应该在 viewInit 没有 context 时也能正常渲染', async () => {
    render(<App />);

    const message: ExtensionMessage = {
      type: 'viewInit',
      view: 'connection-form',
    };

    window.dispatchEvent(new MessageEvent('message', { data: message }));

    await waitFor(() => {
      expect(screen.getByTestId('connection-form')).toBeInTheDocument();
    });
  });
});
