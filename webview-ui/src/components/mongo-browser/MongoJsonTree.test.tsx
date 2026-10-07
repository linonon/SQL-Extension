import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MongoJsonTree } from './MongoJsonTree';

describe('MongoJsonTree', () => {
  it('渲染顶层标量字段', () => {
    render(<MongoJsonTree value={{ aid: 'w-1', n: 14 }} />);
    expect(screen.getByText('aid')).toBeInTheDocument();
    expect(screen.getByText('"w-1"')).toBeInTheDocument();
  });

  it('嵌套对象默认折叠, 点击展开', () => {
    render(<MongoJsonTree value={{ bind: { aid: 'w-1' } }} />);
    expect(screen.queryByText('aid')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('bind'));
    expect(screen.getByText('aid')).toBeInTheDocument();
  });

  it('shell-tag 叶子带类型 badge', () => {
    render(<MongoJsonTree value={{ _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")' }} />);
    expect(screen.getByText('ObjectId')).toBeInTheDocument();
  });

  it('折叠的子文档数组显示内容开头与元素数, 不是 [ n items ]', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, cnt: 5 }));
    render(<MongoJsonTree value={{ bag: { items } }} />);
    expect(screen.getByText(/^\{items:\[\{id:1,cnt:5\},\{id:2,cnt:5\}/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('bag'));
    expect(screen.getByText(/^\[\{id:1,cnt:5\},.*\.\.\. \(60\)$/)).toBeInTheDocument();
  });

  it('Date 叶子悬停显示本地时间', () => {
    render(<MongoJsonTree value={{ t: 'ISODate("2026-01-01T00:00:00.000Z")' }} />);
    expect(screen.getByText('ISODate("2026-01-01T00:00:00.000Z")').closest('[title]'))
      .toHaveAttribute('title', new Date('2026-01-01T00:00:00.000Z').toLocaleString());
  });
});
