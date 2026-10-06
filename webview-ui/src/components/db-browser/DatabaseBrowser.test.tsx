import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DatabaseBrowser, visibleDatabases } from './DatabaseBrowser';
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

  it('系统库默认隐藏可切出; 配了 Database 只列它, 可切到全部; 库分组可折叠, 有过滤词时展开', () => {
    const db = (name: string) => ({ name, tables: [{ name: `${name}_t`, rowCount: 1 }] });
    const all = [db('game'), db('mysql'), db('sys'), db('shop')];
    expect(visibleDatabases(all, 'mysql', { showAll: false, showSystem: false }).map((d) => d.name)).toEqual(['game', 'shop']);
    expect(visibleDatabases(all, 'mysql', { showAll: false, showSystem: true })).toBe(all);
    expect(visibleDatabases(all, 'postgresql', { showAll: false, showSystem: false })).toBe(all);
    // 配的库不在列表里 (没权限 / 写错) 时不藏成空表
    expect(visibleDatabases(all, 'mysql', { defaultDatabase: 'nope', showAll: false, showSystem: false })).toHaveLength(2);

    render(<DatabaseBrowser connectionId="c" driverType="mysql" defaultDatabase="game" />);
    send({ type: 'databaseTableList', databases: all });
    expect(screen.queryByText('shop')).not.toBeInTheDocument();
    expect(screen.queryByText('Show system databases')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show all databases'));
    expect(screen.getByText('shop')).toBeInTheDocument();
    expect(screen.queryByText('mysql')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show system databases'));
    expect(screen.getByText('mysql')).toBeInTheDocument();

    fireEvent.click(screen.getByText('shop'));
    expect(screen.queryByText('shop_t')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Filter db or table/), { target: { value: 'shop' } });
    expect(screen.getByText('shop_t')).toBeInTheDocument();
  });
});
