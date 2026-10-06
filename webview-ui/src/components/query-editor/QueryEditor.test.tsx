import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryEditor, readOnlyReason } from './QueryEditor';
import { ReadOnlyContext } from '../../hooks/useReadOnly';
import { mockPostMessage } from '../../__test__/setup';
import type { ExtensionMessage } from '../../../../src/types/messages';
import type { ColumnInfo } from '../../../../src/types/query';

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
    onExecute?: (caret: number) => void;
  }) => (
    <textarea
      data-testid="sql-editor"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          onExecute?.(e.currentTarget.selectionStart);
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
  QueryHistory: () => <div data-testid="query-history" />,
}));

// mock QueryResultsGrid
vi.mock('./QueryResultsGrid', () => ({
  QueryResultsGrid: ({ columns, rows, error, editable, readOnlyReason, onInsertRow, onSave, onSort, note, onPendingCountChange, onDeleteRows, table }: {
    columns: ColumnInfo[];
    rows: unknown[];
    error?: string;
    editable: boolean;
    readOnlyReason?: string;
    onInsertRow?: unknown;
    onSave?: (updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]) => void;
    onSort?: (column: string) => void;
    note?: string;
    onPendingCountChange?: (count: number) => void;
    onDeleteRows?: (primaryKeys: Record<string, unknown>[]) => void;
    table?: string;
  }) => (
    <div
      data-testid="query-results"
      data-editable={String(editable)}
      data-readonly={readOnlyReason ?? ''}
      data-can-insert={String(!!onInsertRow)}
      data-rows={JSON.stringify(rows)}
      data-note={note ?? ''}
      data-table={table ?? ''}
      data-sources={columns.map((c) => c.source?.table ?? '').join(',')}
    >
      <button data-testid="save" onClick={() => onSave?.([{ primaryKeys: { id: 1 }, changes: { name: 'x' } }])} />
      <button data-testid="sort-v" onClick={() => onSort?.('v')} />
      <button data-testid="edit" onClick={() => onPendingCountChange?.(2)} />
      {onDeleteRows && <button data-testid="delete" onClick={() => onDeleteRows([{ id: 1 }])} />}
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

// 回执须带回最近一次同类请求的 requestId 才会被采用
const lastId = (type: 'executeQuery' | 'listColumns'): number =>
  [...mockPostMessage.mock.calls].reverse().find(([m]) => m.type === type)![0].requestId;

const send = (data: ExtensionMessage) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });

const col = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, dataType: 'int', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '', ...extra,
});

describe('QueryEditor', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('应该渲染 SQL 输入框和执行按钮', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);

    expect(screen.getByPlaceholderText('SELECT * FROM ...')).toBeInTheDocument();
    expect(screen.getByText('Execute')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Enter to execute the statement at cursor')).toBeInTheDocument();
  });

  it('badge 带上连接名, 区分不同环境的同名库', () => {
    render(<QueryEditor connectionId="conn-1" connectionName="release" database="game" />);
    expect(screen.getByText('release / game')).toBeInTheDocument();
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
      requestId: expect.any(Number),
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

  it('宿主回笼统 error (如重连失败) 时结束执行中状态, 不永久转圈', async () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);
    fireEvent.change(screen.getByPlaceholderText('SELECT * FROM ...'), { target: { value: 'SELECT 1' } });
    fireEvent.click(screen.getByText('Execute'));
    expect(screen.getByText('Cancel')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Failed to connect: x' } satisfies ExtensionMessage }));
    });
    expect(screen.getByText('Execute')).toBeInTheDocument();
    expect(document.querySelector('.query-loading')).toBeNull();
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
      requestId: expect.any(Number),
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
      requestId: expect.any(Number),
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
      requestId: lastId('executeQuery'),
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
      requestId: lastId('executeQuery'),
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
      requestId: lastId('executeQuery'),
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
      requestId: expect.any(Number),
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

  it('无选区时 Ctrl+Enter 只执行光标所在的语句, Execute 按钮执行整段', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);
    const textarea = screen.getByPlaceholderText('SELECT * FROM ...') as HTMLTextAreaElement;
    const text = 'SELECT 1;\nUPDATE t SET a = 1;\n';
    const executed = () => mockPostMessage.mock.calls.filter(([m]) => m.type === 'executeQuery').map(([m]) => m.sql);
    const finish = () => send({ type: 'queryResult', requestId: lastId('executeQuery'), columns: [], rows: [], affectedRows: 0, executionTime: 1 });
    fireEvent.change(textarea, { target: { value: text } });

    textarea.setSelectionRange(3, 3);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', ctrlKey: true });
    finish();
    // 光标在结尾的空行里: 算 ; 之前那一条
    textarea.setSelectionRange(text.length, text.length);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', metaKey: true });
    finish();
    fireEvent.click(screen.getByText('Execute'));

    expect(executed()).toEqual(['SELECT 1', 'UPDATE t SET a = 1', 'SELECT 1;\nUPDATE t SET a = 1;']);
  });

  it('PG 的 Ctrl+Enter 按 dollar quote 切分: 光标在函数体里执行整个 DO 块, 不切开也不带上别的语句', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" driverType="postgresql" />);
    const textarea = screen.getByPlaceholderText('SELECT * FROM ...') as HTMLTextAreaElement;
    const block = 'DO $$\nBEGIN\n  UPDATE accounts SET flagged = true WHERE score < 0;\n  DELETE FROM sessions WHERE user_id = 1;\nEND $$';
    const text = `SELECT 1;\n${block};\nSELECT 2;`;
    fireEvent.change(textarea, { target: { value: text } });
    const caret = text.indexOf('DELETE');
    textarea.setSelectionRange(caret, caret);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', metaKey: true });

    const sent = mockPostMessage.mock.calls.filter(([m]) => m.type === 'executeQuery').map(([m]) => m.sql);
    expect(sent).toEqual([block]);
  });

  it('执行中再按 Ctrl+Enter 不发第二条 executeQuery', () => {
    render(<QueryEditor connectionId="conn-1" database="test_db" />);
    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');
    fireEvent.change(textarea, { target: { value: 'SELECT SLEEP(10)' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(mockPostMessage.mock.calls.filter(([m]) => m.type === 'executeQuery')).toHaveLength(1);
  });

  it('db-browser 切表重挂载: 旧编辑器的 queryResult / columnsResult 晚到也不进新编辑器', () => {
    const { unmount } = render(
      <QueryEditor connectionId="c" database="db" table="a" initialSql="SELECT * FROM a" autoExecute />
    );
    const staleQuery = lastId('executeQuery');
    const staleColumns = lastId('listColumns');
    unmount();
    render(<QueryEditor connectionId="c" database="db" table="b" initialSql="SELECT * FROM b" autoExecute />);
    const src = { schema: 'db', table: 'b' };

    send({ type: 'queryResult', requestId: staleQuery, columns: [col('id'), col('uid')], rows: [{ id: 1, uid: 1 }], affectedRows: 0, executionTime: 1 });
    expect(screen.queryByTestId('query-results')).not.toBeInTheDocument();

    // a 的表结构 (主键 aid) 晚于 b 的到达: 不能拿 a 的主键去拼 b 的 UPDATE
    send({ type: 'columnsResult', requestId: lastId('listColumns'), columns: [col('id', { isPrimaryKey: true }), col('uid')] });
    send({ type: 'columnsResult', requestId: staleColumns, columns: [col('aid', { isPrimaryKey: true })] });
    send({
      type: 'queryResult', requestId: lastId('executeQuery'),
      columns: [col('id', { source: src }), col('uid', { source: src })], rows: [{ id: 2, uid: 9 }], affectedRows: 0, executionTime: 1,
    });
    expect(screen.getByTestId('query-results')).toHaveAttribute('data-editable', 'true');
    expect(screen.getByTestId('query-results')).toHaveAttribute('data-table', 'b');
  });

  it('db-browser 切表卸载编辑器: 查询还在跑就发 cancelQuery, 已结束则不发', () => {
    const first = render(<QueryEditor connectionId="c" database="db" table="a" initialSql="SELECT * FROM a" autoExecute />);
    first.unmount();
    expect(mockPostMessage).toHaveBeenLastCalledWith({ type: 'cancelQuery' });

    mockPostMessage.mockClear();
    const second = render(<QueryEditor connectionId="c" database="db" table="b" initialSql="SELECT * FROM b" autoExecute />);
    send({ type: 'queryBatchResult', requestId: lastId('executeQuery'), statements: [] });
    second.unmount();
    expect(mockPostMessage).not.toHaveBeenCalledWith({ type: 'cancelQuery' });
  });

  it('queryBatchResult 带的提示 (事务已回滚) 显示出来, 下次执行清掉', () => {
    render(<QueryEditor connectionId="c" database="db" initialSql="BEGIN" autoExecute />);
    send({
      type: 'queryBatchResult', requestId: lastId('executeQuery'),
      statements: [{ index: 1, sql: 'BEGIN', status: 'ok', affectedRows: 0, executionTime: 1 }],
      warning: 'Open transaction was rolled back when the session closed',
    });
    expect(screen.getByText(/Open transaction was rolled back/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Execute'));
    expect(screen.queryByText(/Open transaction was rolled back/)).not.toBeInTheDocument();
  });

  it('结果不是 panel 表的行: 网格只读并给出原因, Insert 仍可用', () => {
    render(<QueryEditor connectionId="c" database="db" table="users" initialSql="SELECT * FROM users" autoExecute />);
    send({ type: 'columnsResult', requestId: lastId('listColumns'), columns: [col('id', { isPrimaryKey: true }), col('status')] });
    // 用户手改 SQL 查了别的表
    send({
      type: 'queryResult', requestId: lastId('executeQuery'),
      columns: [col('id', { source: { schema: 'db', table: 'orders' } }), col('status', { source: { schema: 'db', table: 'orders' } })],
      rows: [{ id: 1, status: 'x' }], affectedRows: 0, executionTime: 1,
    });
    const grid = screen.getByTestId('query-results');
    expect(grid).toHaveAttribute('data-editable', 'false');
    expect(grid).toHaveAttribute('data-readonly', 'Read-only: result is not a plain selection from users');
    expect(grid).toHaveAttribute('data-can-insert', 'true');
    // Copy as INSERT 不能拿 panel 表名配 orders 的行; 同名列合并表结构后仍保留结果列的来源
    expect(grid).toHaveAttribute('data-table', '');
    expect(grid).toHaveAttribute('data-sources', 'orders,orders');
  });

  it('取表结构失败: 在跑的查询不受影响 (仍可 Cancel), 结果网格只读并说明原因', () => {
    render(<QueryEditor connectionId="c" database="db" table="users" initialSql="SELECT * FROM users" autoExecute />);
    send({ type: 'columnsResult', requestId: lastId('listColumns'), columns: [], error: 'no such table' });
    expect(screen.getByText('Cancel')).toBeInTheDocument();

    const src = { schema: 'db', table: 'users' };
    send({
      type: 'queryResult', requestId: lastId('executeQuery'),
      columns: [col('id', { source: src })], rows: [{ id: 1 }], affectedRows: 0, executionTime: 1,
    });
    const grid = screen.getByTestId('query-results');
    expect(grid).toHaveAttribute('data-editable', 'false');
    expect(grid).toHaveAttribute('data-readonly', 'Read-only: could not load the structure of users: no such table');
  });

  it('只读连接: 本表的结果也不可编辑 / 插入, badge 标出 (read-only)', () => {
    render(
      <ReadOnlyContext.Provider value={true}>
        <QueryEditor connectionId="c" connectionName="release" database="db" table="users" initialSql="SELECT * FROM users" autoExecute />
      </ReadOnlyContext.Provider>
    );
    const src = { schema: 'db', table: 'users' };
    send({ type: 'columnsResult', requestId: lastId('listColumns'), columns: [col('id', { isPrimaryKey: true }), col('name')] });
    send({
      type: 'queryResult', requestId: lastId('executeQuery'),
      columns: [col('id', { source: src }), col('name', { source: src })], rows: [{ id: 1, name: 'a' }], affectedRows: 0, executionTime: 1,
    });
    const grid = screen.getByTestId('query-results');
    expect(grid).toHaveAttribute('data-editable', 'false');
    expect(grid).toHaveAttribute('data-readonly', 'Read-only: connection is read-only');
    expect(grid).toHaveAttribute('data-can-insert', 'false');
    expect(screen.getByText('release / db (read-only)')).toBeInTheDocument();
  });

  it('Save 成功回执: 网格未被新查询替换才重跑刷新, 否则不重跑用户新执行的语句', () => {
    render(<QueryEditor connectionId="c" database="db" table="t" initialSql="SELECT * FROM t" autoExecute />);
    const src = { schema: 'db', table: 't' };
    const showRows = () => send({
      type: 'queryResult', requestId: lastId('executeQuery'),
      columns: [col('id', { source: src }), col('name', { source: src })], rows: [{ id: 1, name: 'a' }], affectedRows: 0, executionTime: 1,
    });
    const executed = () => mockPostMessage.mock.calls.filter(([m]) => m.type === 'executeQuery').map(([m]) => m.sql);
    send({ type: 'columnsResult', requestId: lastId('listColumns'), columns: [col('id', { isPrimaryKey: true }), col('name')] });
    showRows();

    fireEvent.click(screen.getByTestId('save'));
    send({ type: 'batchUpdateResult', success: true });
    expect(executed()).toEqual(['SELECT * FROM t', 'SELECT * FROM t']);

    showRows();
    fireEvent.click(screen.getByTestId('save'));
    // 回执未到, 用户已执行一条写语句
    const textarea = screen.getByPlaceholderText('SELECT * FROM ...');
    fireEvent.change(textarea, { target: { value: 'UPDATE t SET n = n + 1 WHERE id = 5' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    send({ type: 'batchUpdateResult', success: true });
    expect(executed()).toEqual(['SELECT * FROM t', 'SELECT * FROM t', 'UPDATE t SET n = n + 1 WHERE id = 5']);
  });
  it('删行: 发 deleteRows 给宿主, 成功后重跑产出网格的语句, 取消不重跑; 不可编辑的网格没有删除', () => {
    render(<QueryEditor connectionId="c" database="db" table="t" initialSql="SELECT * FROM t" autoExecute />);
    const src = { schema: 'db', table: 't' };
    const executed = () => mockPostMessage.mock.calls.filter(([m]) => m.type === 'executeQuery').map(([m]) => m.sql);
    send({ type: 'columnsResult', requestId: lastId('listColumns'), columns: [col('id', { isPrimaryKey: true }), col('name')] });
    send({ type: 'queryResult', requestId: lastId('executeQuery'), columns: [col('id', { source: src })], rows: [{ id: 1 }], affectedRows: 0, executionTime: 1 });

    fireEvent.click(screen.getByTestId('delete'));
    expect(mockPostMessage).toHaveBeenLastCalledWith({ type: 'deleteRows', database: 'db', table: 't', primaryKeys: [{ id: 1 }] });
    send({ type: 'deleteRowsResult', success: false, cancelled: true });
    expect(executed()).toHaveLength(1);
    fireEvent.click(screen.getByTestId('delete'));
    send({ type: 'deleteRowsResult', success: true });
    expect(executed()).toEqual(['SELECT * FROM t', 'SELECT * FROM t']);

    send({ type: 'queryResult', requestId: lastId('executeQuery'), columns: [col('x')], rows: [{ x: 1 }], affectedRows: 0, executionTime: 1 });
    expect(screen.queryByTestId('delete')).not.toBeInTheDocument();
  });

  it('Save 成功后只重跑产出网格的那条语句, 不重跑同批的写语句', () => {
    render(<QueryEditor connectionId="c" database="db" table="t" initialSql="UPDATE t SET v = 10 WHERE id = 1; SELECT * FROM t" autoExecute />);
    const src = { schema: 'db', table: 't' };
    send({ type: 'columnsResult', requestId: lastId('listColumns'), columns: [col('id', { isPrimaryKey: true }), col('v')] });
    send({
      type: 'queryBatchResult', requestId: lastId('executeQuery'),
      statements: [
        { index: 1, sql: 'UPDATE t SET v = 10 WHERE id = 1', status: 'ok', affectedRows: 1, executionTime: 1 },
        { index: 2, sql: 'SELECT * FROM t', status: 'ok', columns: [col('id', { source: src }), col('v', { source: src })], rows: [{ id: 1, v: 10 }], executionTime: 1 },
      ],
    });
    fireEvent.click(screen.getByTestId('save'));
    send({ type: 'batchUpdateResult', success: true });
    const executed = mockPostMessage.mock.calls.filter(([m]) => m.type === 'executeQuery').map(([m]) => m.sql);
    expect(executed).toEqual(['UPDATE t SET v = 10 WHERE id = 1; SELECT * FROM t', 'SELECT * FROM t']);
  });

  it('表头排序: 默认浏览 SQL 走服务端; 用户改过的 SQL 只排已加载的行, 不覆盖编辑器', () => {
    const browse = 'SELECT * FROM `t` LIMIT 50 OFFSET 0';
    render(<QueryEditor connectionId="c" database="db" driverType="mysql" table="t" initialSql={browse} autoExecute />);
    const textarea = screen.getByPlaceholderText('SELECT * FROM ...') as HTMLTextAreaElement;
    const executed = () => mockPostMessage.mock.calls.filter(([m]) => m.type === 'executeQuery').map(([m]) => m.sql);
    const rows = [{ v: '10' }, { v: null }, { v: '9' }];
    const show = () => send({ type: 'queryResult', requestId: lastId('executeQuery'), columns: [col('v')], rows, affectedRows: 0, executionTime: 1 });
    show();

    fireEvent.click(screen.getByTestId('sort-v'));
    expect(textarea.value).toBe('SELECT * FROM `t` ORDER BY `v` ASC LIMIT 50 OFFSET 0');
    expect(executed()).toHaveLength(2);
    show();

    fireEvent.change(textarea, { target: { value: 'SELECT * FROM t WHERE v > 1' } });
    fireEvent.click(screen.getByText('Execute'));
    show();
    fireEvent.click(screen.getByTestId('sort-v'));
    expect(executed()).toHaveLength(3);
    expect(textarea.value).toBe('SELECT * FROM t WHERE v > 1');
    const grid = screen.getByTestId('query-results');
    expect(JSON.parse(grid.getAttribute('data-rows')!)).toEqual([{ v: '9' }, { v: '10' }, { v: null }]);
    expect(grid).toHaveAttribute('data-note', 'Sorted loaded rows only');
  });

  it('宿主截断的结果集在网格上标出总行数', () => {
    render(<QueryEditor connectionId="c" database="db" initialSql="SELECT * FROM big" autoExecute />);
    send({
      type: 'queryBatchResult', requestId: lastId('executeQuery'),
      statements: [{ index: 1, sql: 'SELECT * FROM big', status: 'ok', columns: [col('v')], rows: [{ v: 1 }, { v: 2 }], rowCount: 12345, truncated: true, executionTime: 1 }],
    });
    expect(screen.getByTestId('query-results')).toHaveAttribute('data-note', 'Showing first 2 of 12345 rows');
  });

  it('上次执行失败: Ask AI 的提问带上报错; 成功后不再带', () => {
    render(<QueryEditor connectionId="c" database="db" initialSql="SELECT * FROM t WHERE stat = 1" autoExecute />);
    send({
      type: 'queryBatchResult', requestId: lastId('executeQuery'),
      statements: [{ index: 1, sql: 'SELECT * FROM t WHERE stat = 1', status: 'error', error: "Unknown column 'stat'" }],
    });
    fireEvent.click(screen.getByText('Ask AI'));
    const input = screen.getByTestId('ai-ask-input');
    const ask = () => {
      fireEvent.change(input, { target: { value: 'fix it' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
      send({ type: 'aiDone', id: [...mockPostMessage.mock.calls].reverse().find(([m]) => m.type === 'aiAsk')![0].id });
    };
    const asked = () => mockPostMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'aiAsk');
    ask();
    expect(asked()[0].lastError).toBe("Unknown column 'stat'");

    fireEvent.click(screen.getByText('Execute'));
    send({ type: 'queryResult', requestId: lastId('executeQuery'), columns: [col('v')], rows: [], affectedRows: 0, executionTime: 1 });
    ask();
    expect(asked()[1]).not.toHaveProperty('lastError');
  });

  it('网格有未保存编辑时重新执行先确认, 确认后才发', () => {
    render(<QueryEditor connectionId="c" database="db" initialSql="SELECT 1" autoExecute />);
    send({ type: 'queryResult', requestId: lastId('executeQuery'), columns: [col('v')], rows: [{ v: 1 }], affectedRows: 0, executionTime: 1 });
    fireEvent.click(screen.getByTestId('edit'));
    const count = () => mockPostMessage.mock.calls.filter(([m]) => m.type === 'executeQuery').length;

    fireEvent.click(screen.getByText('Execute'));
    expect(count()).toBe(1);
    expect(screen.getByText('2 unsaved edits in the grid will be discarded.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Discard and Execute'));
    expect(count()).toBe(2);
    expect(screen.queryByText(/will be discarded/)).not.toBeInTheDocument();
  });
});

describe('readOnlyReason', () => {
  const src = { schema: 'db', table: 't' };
  const table = [col('id', { isPrimaryKey: true }), col('name')];

  it('全部列来自本表且含主键: 可编辑', () => {
    expect(readOnlyReason([col('name', { source: src }), col('id', { source: src })], table, 'db', 't')).toBeNull();
  });

  it('有列不是本表原始列 (表达式 / 别名 / 别的表 / 别的库): 只读', () => {
    const reason = 'Read-only: result is not a plain selection from t';
    expect(readOnlyReason([col('id', { source: src }), col('cnt')], table, 'db', 't')).toBe(reason);
    expect(readOnlyReason([col('id', { source: { schema: 'db', table: 'u' } })], table, 'db', 't')).toBe(reason);
    expect(readOnlyReason([col('id', { source: { schema: 'db2', table: 't' } })], table, 'db', 't')).toBe(reason);
  });

  it('结果缺主键列: 只读 (否则 Save 拼不出 WHERE)', () => {
    expect(readOnlyReason([col('name', { source: src })], table, 'db', 't')).toBe('Read-only: primary key of t is not in the result');
  });

  it('表无主键: 只读', () => {
    expect(readOnlyReason([col('name', { source: src })], [col('name')], 'db', 't')).toBe('Read-only: t has no primary key');
  });
});
