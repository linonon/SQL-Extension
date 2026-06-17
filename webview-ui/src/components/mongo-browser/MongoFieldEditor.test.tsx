import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoFieldEditor } from './MongoFieldEditor';

const doc = {
  _id: 'ObjectId("507f1f77bcf86cd799439011")',
  name: 'Alice',
  age: 30,
  ref: 'ObjectId("aabbccddeeff001122334455")',
};

describe('MongoFieldEditor', () => {
  it('渲染顶层字段, 排除 _id, 只读字段不可编辑', () => {
    render(<MongoFieldEditor document={doc} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('ref')).toBeInTheDocument();
    expect(screen.queryByText('_id')).toBeNull();
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
  });

  it('编辑字段标记 modified, Save 提交重建 EJSON 文档 (不含 _id)', () => {
    const onSave = vi.fn();
    render(<MongoFieldEditor document={doc} onSave={onSave} onCancel={vi.fn()} />);
    const nameInput = screen.getByDisplayValue('Alice');
    fireEvent.change(nameInput, { target: { value: 'Bob' } });
    expect(nameInput.closest('.mongo-fe-row')).toHaveClass('is-modified');

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ name: 'Bob', age: 30, ref: { $oid: 'aabbccddeeff001122334455' } });
  });

  it('数字字段保留类型', () => {
    const onSave = vi.fn();
    render(<MongoFieldEditor document={doc} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ age: 45 }));
  });

  it('删除字段 -> 标记 deleted, Save 省略', () => {
    const onSave = vi.fn();
    render(<MongoFieldEditor document={doc} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '删除字段 age' }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const saved = onSave.mock.calls[0][0];
    expect('age' in saved).toBe(false);
    expect(saved.name).toBe('Alice');
  });

  it('revert 撤销修改', () => {
    render(<MongoFieldEditor document={doc} onSave={vi.fn()} onCancel={vi.fn()} />);
    const nameInput = screen.getByDisplayValue('Alice');
    fireEvent.change(nameInput, { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: '还原字段 name' }));
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
  });

  it('H5: saveSignal 变化触发 save (切换时保存不丢改动)', () => {
    const onSave = vi.fn();
    const { rerender } = render(<MongoFieldEditor document={doc} onSave={onSave} onCancel={vi.fn()} saveSignal={0} />);
    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'Bob' } });
    rerender(<MongoFieldEditor document={doc} onSave={onSave} onCancel={vi.fn()} saveSignal={1} />);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bob' }));
  });

  it('round2 #6: 同 _id refetch (新对象引用) 不清空在编辑的草稿', () => {
    const d1 = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'Alice' };
    const { rerender } = render(<MongoFieldEditor document={d1} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'Bob' } });
    // 模拟后台 refetch: 相同 _id, 新对象引用
    rerender(<MongoFieldEditor document={{ _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'Alice' }} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByDisplayValue('Bob')).toBeInTheDocument();
  });

  it('H7: 新增字段 key 输入连续编辑不失焦 (稳定 React key)', () => {
    render(<MongoFieldEditor document={doc} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /添加字段/ }));
    const keyInputs = document.querySelectorAll('.mongo-fe-key-input');
    const keyInput = keyInputs[keyInputs.length - 1] as HTMLInputElement;
    keyInput.focus();
    expect(document.activeElement).toBe(keyInput);
    fireEvent.change(keyInput, { target: { value: 'c' } });
    expect(document.activeElement).toBe(keyInput);
  });

  it('C1: 只读负数 Int 字段保存时类型/值不损坏', () => {
    const onSave = vi.fn();
    const d = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'Alice', n: 'NumberInt(-5)' };
    render(<MongoFieldEditor document={d} onSave={onSave} onCancel={vi.fn()} />);
    // 改 name 触发 dirty
    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bob', n: { $numberInt: '-5' } }));
  });

  it('C2: 新字段填入形似 tag 的字符串按字面量保存, 不崩溃', () => {
    const onSave = vi.fn();
    render(<MongoFieldEditor document={doc} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /添加字段/ }));
    const keyInputs = document.querySelectorAll('.mongo-fe-key-input');
    fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: 'note' } });
    const rows = document.querySelectorAll('.mongo-fe-row');
    const valueInput = rows[rows.length - 1].querySelector('.mongo-fe-value-input') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'ObjectId("xyz")' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ note: 'ObjectId("xyz")' }));
  });

  it('L2: 新字段有值但 key 为空 -> 阻止保存并提示', () => {
    const onSave = vi.fn();
    render(<MongoFieldEditor document={doc} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /添加字段/ }));
    const rows = document.querySelectorAll('.mongo-fe-row');
    const valueInput = rows[rows.length - 1].querySelector('.mongo-fe-value-input') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'orphan' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/字段名|key/i)).toBeInTheDocument();
  });

  it('添加字段 -> Save 含新字段', () => {
    const onSave = vi.fn();
    render(<MongoFieldEditor document={doc} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /添加字段/ }));
    const keyInputs = document.querySelectorAll('.mongo-fe-key-input');
    fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: 'city' } });
    const rows = document.querySelectorAll('.mongo-fe-row');
    const valueInput = rows[rows.length - 1].querySelector('.mongo-fe-value-input') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'NYC' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ city: 'NYC' }));
  });
});
