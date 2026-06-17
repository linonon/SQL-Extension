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

  describe('单元格原地编辑', () => {
    const editCols = [
      { name: '_id', dataType: 'ObjectId', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
      { name: 'name', dataType: 'string', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      { name: 'age', dataType: 'number', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
    ];
    const editRows = [{ _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', name: 'Alice', age: 30 }];
    const editId = 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")';

    it('双击字符串单元格 -> Enter 提交 onCellEdit(idShell, path, string)', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onRowClick={vi.fn()} onCellEdit={onCellEdit} />);
      fireEvent.doubleClick(screen.getByText('Alice'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      expect(input).not.toBeNull();
      fireEvent.change(input, { target: { value: 'Bob' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onCellEdit).toHaveBeenCalledWith(editId, 'name', 'Bob');
    });

    it('数字单元格编辑 -> 提交 number 类型 (保留类型)', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onRowClick={vi.fn()} onCellEdit={onCellEdit} />);
      fireEvent.doubleClick(screen.getByText('30'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '45' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onCellEdit).toHaveBeenCalledWith(editId, 'age', 45);
    });

    it('清空数字单元格不静默写 0 (回退原值) — H4', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onRowClick={vi.fn()} onCellEdit={onCellEdit} />);
      fireEvent.doubleClick(screen.getByText('30'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onCellEdit).toHaveBeenCalledWith(editId, 'age', 30);
    });

    it('_id 单元格不可原地编辑', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onRowClick={vi.fn()} onCellEdit={onCellEdit} />);
      fireEvent.doubleClick(screen.getByText(/ObjectId\("a+"\)/));
      expect(document.querySelector('.mongo-cell-input')).toBeNull();
    });

    it('M6: 单元格失焦 (blur) 提交改动而非丢弃', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onRowClick={vi.fn()} onCellEdit={onCellEdit} />);
      fireEvent.doubleClick(screen.getByText('Alice'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Bob' } });
      fireEvent.blur(input);
      expect(onCellEdit).toHaveBeenCalledWith(editId, 'name', 'Bob');
    });

    it('Esc 取消编辑, 不提交', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onRowClick={vi.fn()} onCellEdit={onCellEdit} />);
      fireEvent.doubleClick(screen.getByText('Alice'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Bob' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(onCellEdit).not.toHaveBeenCalled();
      expect(document.querySelector('.mongo-cell-input')).toBeNull();
    });
  });
});
