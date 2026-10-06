import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryResultsGrid } from './QueryResultsGrid';
import type { ColumnInfo } from '../../types/database';

const columns: ColumnInfo[] = [
  { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
  { name: 'ts', dataType: 'timestamp', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
];
const rows = [{ id: 1, ts: '2024-01-01 00:00:00' }];

const baseProps = {
  affectedRows: 0,
  executionTime: 1,
  editable: true,
  saving: false,
  onSave: () => {},
};

describe('QueryResultsGrid hooks order', () => {
  // save 后父组件用 UPDATE 的结果 (columns/rows 为空) 重渲染.
  // 若组件在 early return 之后才调用 hook, 这次重渲染调用的 hook 数会变少,
  // 触发 React #300 "Rendered fewer hooks than expected", 整个 webview 崩成黑屏.
  it('从有数据重渲染到空结果不应抛 hooks 数量错误', () => {
    const { rerender } = render(
      <QueryResultsGrid {...baseProps} columns={columns} rows={rows} />
    );
    expect(() =>
      rerender(<QueryResultsGrid {...baseProps} columns={[]} rows={[]} affectedRows={1} />)
    ).not.toThrow();
  });

  it('从有数据重渲染到 error 状态不应抛 hooks 数量错误', () => {
    const { rerender } = render(
      <QueryResultsGrid {...baseProps} columns={columns} rows={rows} />
    );
    expect(() =>
      rerender(<QueryResultsGrid {...baseProps} columns={[]} rows={[]} error="update failed" />)
    ).not.toThrow();
  });

  // 保存失败 (saveError) 必须保留结果表, 仅行内提示; 不能像 error (查询失败) 那样整表替换,
  // 否则用户丢失数据与未保存编辑, 只能重跑 query.
  it('saveError 保留表格并行内提示, 不替换结果', () => {
    render(
      <QueryResultsGrid
        {...baseProps}
        columns={columns}
        rows={rows}
        saveError="Incorrect datetime value for column 'ts'"
      />
    );
    // 表格仍在
    expect(screen.getByRole('table')).toBeInTheDocument();
    // 错误以行内 banner 展示
    expect(screen.getByText(/Incorrect datetime value/)).toBeInTheDocument();
  });
});

// jsdom 没有布局, 虚拟滚动量到的视口高度是 0 就不渲染数据行: 给个固定高度
beforeAll(() => { vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600); });
afterAll(() => { vi.restoreAllMocks(); });

const c = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, dataType: 'varchar(32)', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '', ...extra,
});

describe('QueryResultsGrid 编辑', () => {
  const editCols = [c('id', { dataType: 'int', nullable: false, isPrimaryKey: true }), c('nick', { nullable: false, defaultValue: '' }), c('note', { dataType: 'text' })];
  const cell = (col: string, row = 0) => document.querySelectorAll(`td[data-col="${col}"]`)[row];
  const cmdS = () => fireEvent.keyDown(window, { key: 's', metaKey: true });

  it('多行文本原样编辑; Shift+Enter 换行不提交; 编辑态 Cmd+S 先提交这一格再存', () => {
    const onSave = vi.fn();
    render(<QueryResultsGrid {...baseProps} onSave={onSave} columns={editCols} rows={[{ id: 1, nick: 'n', note: 'a\nb' }]} />);
    fireEvent.doubleClick(cell('note'));
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(editor.tagName).toBe('TEXTAREA');
    expect(editor.value).toBe('a\nb');
    fireEvent.change(editor, { target: { value: 'a\nb\nc' } });
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    cmdS();
    expect(onSave).toHaveBeenCalledWith([{ primaryKeys: { id: 1 }, changes: { note: 'a\nb\nc' } }]);
  });

  it('空串不是 NULL: NOT NULL 列能清空, 原值为空串的格子回车不报错不算改动; Set NULL 走右键', () => {
    const onSave = vi.fn();
    render(<QueryResultsGrid {...baseProps} onSave={onSave} columns={editCols} rows={[{ id: 1, nick: '', note: 'x' }, { id: 2, nick: 'bob', note: 'y' }]} />);
    // 原值 '' 原样回车
    fireEvent.doubleClick(cell('nick'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(screen.queryByText(/不可为空/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
    // NOT NULL 列清空成 ''
    fireEvent.doubleClick(cell('nick', 1));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    // nullable 列右键 Set NULL; NOT NULL 列上 Set NULL 不可用
    fireEvent.contextMenu(cell('note'));
    fireEvent.click(screen.getByText('Set NULL'));
    fireEvent.contextMenu(cell('nick'));
    expect(screen.getByText('Set NULL').closest('.context-menu-item')).toHaveClass('disabled');
    fireEvent.keyDown(document, { key: 'Escape' });
    cmdS();
    expect(onSave).toHaveBeenCalledWith([
      { primaryKeys: { id: 2 }, changes: { nick: '' } },
      { primaryKeys: { id: 1 }, changes: { note: null } },
    ]);
  });

  it('NULL 格子: 打开再回车不算改动; 输入后清空提交为空串; 有未保存编辑时 Insert 先拦', () => {
    const onSave = vi.fn();
    const onInsertRow = vi.fn();
    render(<QueryResultsGrid {...baseProps} onSave={onSave} onInsertRow={onInsertRow} columns={editCols} rows={[{ id: 1, nick: 'n', note: null }, { id: 2, nick: 'm', note: null }]} />);
    fireEvent.doubleClick(cell('note'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
    fireEvent.doubleClick(cell('note', 1));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.contextMenu(cell('note'));
    fireEvent.click(screen.getByText('Insert New Row'));
    expect(screen.getByText(/未保存编辑.*再插入/)).toBeInTheDocument();
    expect(document.querySelector('.clone-row-field')).toBeNull();
    cmdS();
    expect(onSave).toHaveBeenCalledWith([{ primaryKeys: { id: 2 }, changes: { note: '' } }]);
  });
});

describe('QueryResultsGrid 空结果 / Insert / CSV', () => {
  const tableColumns = [c('id', { dataType: 'int', nullable: false, isPrimaryKey: true, extra: 'auto_increment' }), c('name'), c('level', { dataType: 'int', nullable: false })];

  it('0 行结果集也有表头和 0 rows; 空白处右键 Insert, 表单含结果集没选出的 NOT NULL 列且可填', () => {
    render(
      <QueryResultsGrid {...baseProps} columns={[c('id', { source: undefined }), c('name')]} rows={[]}
        tableColumns={tableColumns} onInsertRow={() => {}} />
    );
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText(/^0 rows in/)).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole('table').parentElement!);
    fireEvent.click(screen.getByText('Insert New Row'));
    const level = screen.getByText('level').closest('.clone-row-field')!.querySelector('input[type="text"]') as HTMLInputElement;
    expect(level.disabled).toBe(false);
  });

  it('没勾选时导出全部行 (菜单写明), 勾选时只导出勾选行', () => {
    const onExportCsv = vi.fn();
    render(<QueryResultsGrid {...baseProps} columns={columns} rows={[{ id: 1, ts: null }, { id: 2, ts: null }]} onExportCsv={onExportCsv} />);
    fireEvent.contextMenu(screen.getByRole('table').parentElement!);
    fireEvent.mouseEnter(screen.getByText('Export'));
    fireEvent.click(screen.getByText('CSV (all 2 rows)'));
    expect(onExportCsv.mock.lastCall![0]).toBe('\uFEFFid,ts\r\n1,\r\n2,');
    fireEvent.click(screen.getAllByRole('checkbox')[2]);
    fireEvent.contextMenu(screen.getByRole('table').parentElement!);
    fireEvent.mouseEnter(screen.getByText('Export'));
    fireEvent.click(screen.getByText('CSV (1 selected)'));
    expect(onExportCsv.mock.lastCall![0]).toBe('\uFEFFid,ts\r\n2,');
  });

  it('宿主截断过的结果, 菜单写明只导出已加载的行', () => {
    render(<QueryResultsGrid {...baseProps} columns={columns} rows={rows} truncated onExportCsv={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('table').parentElement!);
    fireEvent.mouseEnter(screen.getByText('Export'));
    expect(screen.getByText('CSV (first 1 loaded rows)')).toBeInTheDocument();
  });
});
