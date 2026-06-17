import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoAggregationBuilder } from './MongoAggregationBuilder';

describe('MongoAggregationBuilder', () => {
  it('默认渲染一个 stage', () => {
    render(<MongoAggregationBuilder collection="users" onGenerate={vi.fn()} />);
    expect(document.querySelectorAll('.mongo-agg-stage')).toHaveLength(1);
  });

  it('添加 stage -> 多一张卡片', () => {
    render(<MongoAggregationBuilder collection="users" onGenerate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ stage/i }));
    expect(document.querySelectorAll('.mongo-agg-stage')).toHaveLength(2);
  });

  it('填 stage + 应用 -> onGenerate 带 aggregate 查询串', () => {
    const onGenerate = vi.fn();
    render(<MongoAggregationBuilder collection="users" onGenerate={onGenerate} />);
    fireEvent.change(document.querySelector('.mongo-agg-op') as HTMLSelectElement, { target: { value: '$match' } });
    fireEvent.change(document.querySelector('.mongo-agg-body') as HTMLTextAreaElement, { target: { value: '{"age":{"$gt":18}}' } });
    fireEvent.click(screen.getByRole('button', { name: /应用到查询/ }));
    expect(onGenerate).toHaveBeenCalledWith('db.users.aggregate([{"$match":{"age":{"$gt":18}}}])');
  });

  it('非法 body -> 显示错误, 不调用 onGenerate', () => {
    const onGenerate = vi.fn();
    render(<MongoAggregationBuilder collection="c" onGenerate={onGenerate} />);
    fireEvent.change(document.querySelector('.mongo-agg-body') as HTMLTextAreaElement, { target: { value: '{bad}' } });
    fireEvent.click(screen.getByRole('button', { name: /应用到查询/ }));
    expect(onGenerate).not.toHaveBeenCalled();
    expect(screen.getByText(/invalid JSON/i)).toBeInTheDocument();
  });

  it('移除 stage', () => {
    render(<MongoAggregationBuilder collection="users" onGenerate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ stage/i }));
    expect(document.querySelectorAll('.mongo-agg-stage')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: /移除 stage/ })[0]);
    expect(document.querySelectorAll('.mongo-agg-stage')).toHaveLength(1);
  });
});
