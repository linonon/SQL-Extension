import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoFilterBuilder } from './MongoFilterBuilder';

describe('MongoFilterBuilder', () => {
  it('填一个条件 + 应用 -> onGenerate 带生成的 filter JSON', () => {
    const onGenerate = vi.fn();
    render(<MongoFilterBuilder fieldNames={['age', 'name']} onGenerate={onGenerate} />);

    fireEvent.change(document.querySelector('.mongo-fb-field') as HTMLInputElement, { target: { value: 'age' } });
    fireEvent.change(document.querySelector('.mongo-fb-op') as HTMLSelectElement, { target: { value: '$gt' } });
    fireEvent.change(document.querySelector('.mongo-fb-value') as HTMLInputElement, { target: { value: '18' } });

    fireEvent.click(screen.getByRole('button', { name: /应用筛选/ }));
    expect(onGenerate).toHaveBeenCalledWith('{"age":{"$gt":18}}');
  });

  it('添加条件 -> 多一行', () => {
    render(<MongoFilterBuilder fieldNames={[]} onGenerate={vi.fn()} />);
    expect(document.querySelectorAll('.mongo-fb-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /添加条件/ }));
    expect(document.querySelectorAll('.mongo-fb-row')).toHaveLength(2);
  });

  it('删除条件行', () => {
    render(<MongoFilterBuilder fieldNames={[]} onGenerate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /添加条件/ }));
    expect(document.querySelectorAll('.mongo-fb-row')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: /移除条件/ })[0]);
    expect(document.querySelectorAll('.mongo-fb-row')).toHaveLength(1);
  });
});
