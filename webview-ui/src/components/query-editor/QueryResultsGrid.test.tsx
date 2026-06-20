import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
