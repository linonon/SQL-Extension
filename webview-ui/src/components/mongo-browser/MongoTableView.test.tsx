import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoTableView } from './MongoTableView';

const columns = [
  { name: '_id', dataType: 'ObjectId', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
  { name: 'bind', dataType: 'object', nullable: true, defaultValue: null, isPrimaryKey: false, extra: '' },
];
const rows = [{ _id: 'ObjectId("a")', bind: { aid: 'w-1' } }];

describe('MongoTableView', () => {
  it('嵌套对象单元格显示 JSON 预览而非 [object Object]', () => {
    render(<MongoTableView columns={columns} rows={rows} onRowClick={vi.fn()} />);
    expect(screen.getByText(/"aid":"w-1"/)).toBeInTheDocument();
  });

  it('点行回调带该行', () => {
    const onRowClick = vi.fn();
    render(<MongoTableView columns={columns} rows={rows} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText(/"aid":"w-1"/).closest('tr')!);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it('展开 object 列 -> 内嵌字段以完整 path 成列, 单元格显示叶子值', () => {
    render(<MongoTableView columns={columns} rows={rows} onRowClick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /expand bind/i }));
    expect(screen.getByText('bind.aid')).toBeInTheDocument();
    expect(screen.getByText('w-1')).toBeInTheDocument();
    // 展开后不再显示整体 JSON 预览
    expect(screen.queryByText(/"aid":"w-1"/)).toBeNull();
  });

  it('折叠展开的内嵌字段 -> 回到 object 列', () => {
    render(<MongoTableView columns={columns} rows={rows} onRowClick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /expand bind/i }));
    fireEvent.click(screen.getByRole('button', { name: /collapse bind/i }));
    expect(screen.queryByText('bind.aid')).toBeNull();
    expect(screen.getByText(/"aid":"w-1"/)).toBeInTheDocument();
  });
});
