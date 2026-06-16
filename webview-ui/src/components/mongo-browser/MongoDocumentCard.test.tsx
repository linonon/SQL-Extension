import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoDocumentCard } from './MongoDocumentCard';

const doc = { _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', aid: 'w-1' };

describe('MongoDocumentCard', () => {
  it('list 视图渲染树, 含字段名', () => {
    render(<MongoDocumentCard doc={doc} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('aid')).toBeInTheDocument();
  });

  it('json 视图渲染 shell 文本', () => {
    render(<MongoDocumentCard doc={doc} view="json" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/ObjectId\("a+"\)/)).toBeInTheDocument();
  });

  it('点 Edit 回调带文档', () => {
    const onEdit = vi.fn();
    render(<MongoDocumentCard doc={doc} view="list" onEdit={onEdit} onClone={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(doc);
  });

  it('Delete 传去 ObjectId 内的裸 id 而非 shell-tag', () => {
    const onDelete = vi.fn();
    render(<MongoDocumentCard doc={{ _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', aid: 'w' }} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
