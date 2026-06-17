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
