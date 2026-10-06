import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DatabaseBrowser } from './DatabaseBrowser';
import { mockPostMessage } from '../../__test__/setup';
import type { ExtensionMessage } from '../../types/messages';

vi.mock('../query-editor/QueryEditor', () => ({
  QueryEditor: ({ table, onPendingEditsChange }: { table: string; onPendingEditsChange?: (n: number) => void }) => (
    <div data-testid="editor">
      {table}
      <button data-testid="edit" onClick={() => onPendingEditsChange?.(1)} />
    </div>
  ),
}));

const send = (data: ExtensionMessage) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });

const tables = { name: 'db', tables: [{ name: 'a', rowCount: 1 }, { name: 'b', rowCount: 1 }] };

describe('DatabaseBrowser', () => {
  it('列表加载失败显示错误和 Retry, 不显示 No tables found', () => {
    render(<DatabaseBrowser connectionId="c" driverType="mysql" />);
    send({ type: 'databaseTableList', databases: [], error: 'Access denied for user' });
    expect(screen.getByText('Access denied for user')).toBeInTheDocument();
    expect(screen.queryByText('No tables found')).not.toBeInTheDocument();
    mockPostMessage.mockClear();
    fireEvent.click(screen.getByText('Retry'));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'listDatabasesAndTables' });
  });

  it('当前表有未保存编辑时切表先确认', () => {
    render(<DatabaseBrowser connectionId="c" driverType="mysql" />);
    send({ type: 'databaseTableList', databases: [tables] });
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(screen.getByTestId('edit'));

    fireEvent.click(screen.getByText('b'));
    expect(screen.getByTestId('editor')).toHaveTextContent('a');
    fireEvent.click(screen.getByText('Discard and Open b'));
    expect(screen.getByTestId('editor')).toHaveTextContent('b');
  });
});
