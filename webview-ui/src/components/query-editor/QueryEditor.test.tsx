import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryEditor } from './QueryEditor';
import { mockPostMessage } from '../../__test__/setup';
import type { ExtensionMessage } from '../../types/messages';

// mock SqlEditor: 用 textarea 模拟编辑器行为
vi.mock('../sql-editor/SqlEditor', () => ({
  SqlEditor: ({
    value,
    onChange,
    placeholder,
    onExecute,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    onExecute?: () => void;
  }) => (
    <textarea
      data-testid="sql-editor"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          onExecute?.();
        }
      }}
    />
  ),
}));

// mock sql-formatter
vi.mock('../../utils/format-sql', () => ({
  formatSql: (sql: string) => sql,
}));

// mock QueryHistory
vi.mock('./QueryHistory', () => ({
  useQueryHistory: () => ({ entries: [], addEntry: vi.fn() }),
  QueryHistory: () => <div data-testid="query-history" />,
}));

// mock QueryResultsGrid
vi.mock('./QueryResultsGrid', () => ({
  QueryResultsGrid: ({ columns, rows, error }: {
    columns: unknown[];
    rows: unknown[];
    error?: string;
  }) => (
    <div data-testid="query-results">
      {error ? (
        <div data-testid="error">{error}</div>
      ) : (
        <div data-testid="data">
          {columns.length} columns, {rows.length} rows
        </div>
      )}
    </div>
  ),
}));

describe('QueryEditor', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('应该渲染 SQL 输入框和执行按钮', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    expect(screen.getByPlaceholderText('SELECT * FROM ...')).toBeInTheDocument();
    expect(screen.getByText('Execute')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Enter to execute')).toBeInTheDocument();
  });

  it('应该在 SQL 为空时禁用 Execute 按钮', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const executeButton = screen.getByText('Execute');
    expect(executeButton).toBeDisabled();
  });

  it('应该在输入 SQL 后启用 Execute 按钮', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');
    const executeButton = screen.getByText('Execute');

    fireEvent.change(textarea, { target: { value: 'SELECT * FROM users' } });

    expect(executeButton).not.toBeDisabled();
  });

  it('应该在点击 Execute 按钮时发送 executeQuery 消息', () => {
    render(<QueryEditor connectionId="conn-1" database="prod_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');
    const executeButton = screen.getByText('Execute');

    fireEvent.change(textarea, { target: { value: 'SELECT * FROM products WHERE id = 1' } });
    fireEvent.click(executeButton);

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'executeQuery',
      database: 'prod_db',
      sql: 'SELECT * FROM products WHERE id = 1',
    });
  });

  it('应该在执行中显示 Cancel 按钮', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');

    fireEvent.change(textarea, { target: { value: 'SELECT 1' } });
    fireEvent.click(screen.getByText('Execute'));

    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.queryByText('Execute')).not.toBeInTheDocument();
  });

  it('应该在点击 Cancel 时发送 cancelQuery 消息', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');

    fireEvent.change(textarea, { target: { value: 'SELECT 1' } });
    fireEvent.click(screen.getByText('Execute'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'cancelQuery' });
  });

  it('应该在按下 Ctrl+Enter 时执行查询', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');

    fireEvent.change(textarea, { target: { value: 'SELECT * FROM orders' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'executeQuery',
      database: 'test_db',
      sql: 'SELECT * FROM orders',
    });
  });

  it('应该在按下 Meta+Enter (Mac) 时执行查询', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');

    fireEvent.change(textarea, { target: { value: 'SELECT * FROM customers' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'executeQuery',
      database: 'test_db',
      sql: 'SELECT * FROM customers',
    });
  });

  it('应该在收到 queryResult 消息后显示结果', async () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');
    fireEvent.change(textarea, { target: { value: 'SELECT * FROM users' } });
    fireEvent.click(screen.getByText('Execute'));

    const resultMessage: ExtensionMessage = {
      type: 'queryResult',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
        { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      ],
      rows: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
      affectedRows: 0,
      executionTime: 25,
    };

    window.dispatchEvent(new MessageEvent('message', { data: resultMessage }));

    await waitFor(() => {
      expect(screen.getByTestId('query-results')).toBeInTheDocument();
      expect(screen.getByText('2 columns, 2 rows')).toBeInTheDocument();
    });

    expect(screen.getByText('Execute')).not.toBeDisabled();
  });

  it('应该在收到错误结果后显示错误信息', async () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');
    fireEvent.change(textarea, { target: { value: 'INVALID SQL' } });
    fireEvent.click(screen.getByText('Execute'));

    const errorMessage: ExtensionMessage = {
      type: 'queryResult',
      columns: [],
      rows: [],
      affectedRows: 0,
      executionTime: 5,
      error: 'Syntax error at line 1',
    };

    window.dispatchEvent(new MessageEvent('message', { data: errorMessage }));

    await waitFor(() => {
      expect(screen.getByTestId('error')).toBeInTheDocument();
      expect(screen.getByText('Syntax error at line 1')).toBeInTheDocument();
    });
  });

  it('应该在执行新查询时清除旧结果', async () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');

    fireEvent.change(textarea, { target: { value: 'SELECT 1' } });
    fireEvent.click(screen.getByText('Execute'));

    const result1: ExtensionMessage = {
      type: 'queryResult',
      columns: [{ name: '1', dataType: 'int', nullable: false, isPrimaryKey: false, defaultValue: null, extra: '' }],
      rows: [{ '1': 1 }],
      affectedRows: 0,
      executionTime: 5,
    };

    window.dispatchEvent(new MessageEvent('message', { data: result1 }));

    await waitFor(() => {
      expect(screen.getByText('1 columns, 1 rows')).toBeInTheDocument();
    });

    fireEvent.change(textarea, { target: { value: 'SELECT 2' } });
    fireEvent.click(screen.getByText('Execute'));

    expect(screen.queryByTestId('query-results')).not.toBeInTheDocument();
  });

  it('应该 trim SQL 前后的空格后再发送', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');

    fireEvent.change(textarea, { target: { value: '  \n  SELECT * FROM users  \n  ' } });
    fireEvent.click(screen.getByText('Execute'));

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'executeQuery',
      database: 'test_db',
      sql: 'SELECT * FROM users',
    });
  });

  it('应该在 SQL 只有空格时不发送请求', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);
    mockPostMessage.mockClear();

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');

    fireEvent.change(textarea, { target: { value: '   \n   ' } });
    fireEvent.click(screen.getByText('Execute'));

    expect(mockPostMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'executeQuery' }),
    );
  });

  it('应该在按下普通 Enter 时不执行查询', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);
    mockPostMessage.mockClear();

    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');

    fireEvent.change(textarea, { target: { value: 'SELECT 1' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(mockPostMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'executeQuery' }),
    );
  });

  it('应该在 mount 时发送 requestSchema 消息', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'requestSchema',
      database: 'test_db',
    });
  });
});
