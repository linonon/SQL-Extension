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
});
