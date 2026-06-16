import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoDocumentList } from './MongoDocumentList';

const rows = [
  { _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', aid: 'w-1' },
  { _id: 1102025811, aid: 'w-2' },
];

describe('MongoDocumentList', () => {
  it('渲染每个文档一张卡片', () => {
    render(<MongoDocumentList rows={rows} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getAllByText('aid')).toHaveLength(2);
  });
});
