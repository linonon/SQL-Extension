import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoTableView } from './MongoTableView';

const columns = [
  { name: '_id', dataType: 'ObjectId', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
  { name: 'bind', dataType: 'object', nullable: true, defaultValue: null, isPrimaryKey: false, extra: '' },
];
const rows = [{ _id: 'ObjectId("a")', bind: { aid: 'w-1' } }];

// 真实浏览器里双击先派发两次 click 再派发 dblclick
const userDoubleClick = (el: Element) => {
  fireEvent.click(el);
  fireEvent.click(el);
  fireEvent.doubleClick(el);
};

describe('MongoTableView', () => {
  it('嵌套对象单元格显示 JSON 预览而非 [object Object]', () => {
    render(<MongoTableView columns={columns} rows={rows} />);
    expect(screen.getByText(/"aid":"w-1"/)).toBeInTheDocument();
  });

  it('点 _id 单元格打开该行; 点其他单元格不打开', () => {
    const onOpen = vi.fn();
    render(<MongoTableView columns={columns} rows={rows} onOpen={onOpen} />);
    fireEvent.click(screen.getByText(/"aid":"w-1"/));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ObjectId("a")' }));
    expect(onOpen).toHaveBeenCalledWith(rows[0]);
  });

  it('复合 _id 展开后: 首个 _id.* 列打开文档, _id.* 单元格不可原地编辑', () => {
    const onOpen = vi.fn();
    const onCellEdit = vi.fn();
    const compound = [{ _id: { uid: 7, day: 'd1' }, n: 1 }];
    render(<MongoTableView columns={[columns[0], { ...columns[1], name: 'n' }]} rows={compound} onOpen={onOpen} onCellEdit={onCellEdit} />);
    fireEvent.click(screen.getByRole('button', { name: /expand _id/i }));
    userDoubleClick(screen.getByText('d1'));
    expect(document.querySelector('.mongo-cell-input')).toBeNull();
    expect(screen.getAllByRole('button', { name: '7' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '7' }));
    expect(onOpen).toHaveBeenCalledWith(compound[0]);
  });

  it('复合 _id 的行 key 不冲突', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const compound = [{ _id: { uid: 1, day: 'a' }, n: 1 }, { _id: { uid: 2, day: 'a' }, n: 2 }];
    render(<MongoTableView columns={[columns[0], { ...columns[1], name: 'n' }]} rows={compound} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(spy.mock.calls.some(([m]) => String(m).includes('same key'))).toBe(false);
    spy.mockRestore();
  });

  it('展开 object 列 -> 内嵌字段以完整 path 成列, 单元格显示叶子值', () => {
    render(<MongoTableView columns={columns} rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: /expand bind/i }));
    expect(screen.getByText('bind.aid')).toBeInTheDocument();
    expect(screen.getByText('w-1')).toBeInTheDocument();
    // 展开后不再显示整体 JSON 预览
    expect(screen.queryByText(/"aid":"w-1"/)).toBeNull();
  });

  it('折叠展开的内嵌字段 -> 回到 object 列', () => {
    render(<MongoTableView columns={columns} rows={rows} />);
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

    it('双击字符串单元格 -> Enter 提交 onCellEdit(_id, path, 原值, 新值); 双击前的两次单击不打开文档', () => {
      const onCellEdit = vi.fn();
      const onOpen = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onOpen={onOpen} onCellEdit={onCellEdit} />);
      userDoubleClick(screen.getByText('Alice'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      expect(input).not.toBeNull();
      fireEvent.change(input, { target: { value: 'Bob' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onCellEdit).toHaveBeenCalledWith(editId, 'name', 'Alice', 'Bob');
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('数字单元格编辑 -> 提交 number 类型 (保留类型)', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onCellEdit={onCellEdit} />);
      userDoubleClick(screen.getByText('30'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '45' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onCellEdit).toHaveBeenCalledWith(editId, 'age', 30, 45);
    });

    it('清空数字单元格不静默写 0: 回退原值, 值没变不发写请求', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onCellEdit={onCellEdit} />);
      userDoubleClick(screen.getByText('30'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onCellEdit).not.toHaveBeenCalled();
    });

    it('_id 单元格不可原地编辑', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onCellEdit={onCellEdit} />);
      userDoubleClick(screen.getByText(/ObjectId\("a+"\)/));
      expect(document.querySelector('.mongo-cell-input')).toBeNull();
    });

    it('M6: 单元格失焦 (blur) 提交改动而非丢弃', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onCellEdit={onCellEdit} />);
      userDoubleClick(screen.getByText('Alice'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Bob' } });
      fireEvent.blur(input);
      expect(onCellEdit).toHaveBeenCalledWith(editId, 'name', 'Alice', 'Bob');
    });

    it('Enter 提交后再 blur 不重复提交 (review round2 #2)', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onCellEdit={onCellEdit} />);
      userDoubleClick(screen.getByText('Alice'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Bob' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      // 模拟 Enter 提交后 input 仍触发的 blur (真实浏览器 unmount focused 元素会触发)
      fireEvent.blur(input);
      expect(onCellEdit).toHaveBeenCalledTimes(1);
    });

    it('Esc 取消编辑, 不提交', () => {
      const onCellEdit = vi.fn();
      render(<MongoTableView columns={editCols} rows={editRows} onCellEdit={onCellEdit} />);
      userDoubleClick(screen.getByText('Alice'));
      const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Bob' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(onCellEdit).not.toHaveBeenCalled();
      expect(document.querySelector('.mongo-cell-input')).toBeNull();
    });
  });
});
