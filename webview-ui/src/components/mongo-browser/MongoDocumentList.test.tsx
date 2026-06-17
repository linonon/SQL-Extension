import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';
import { MongoDocumentList } from './MongoDocumentList';

vi.mock('../../hooks/useMongoAutocomplete', () => ({
  useMongoAutocomplete: ({ onChange }: { onChange: (v: string) => void }) => ({
    textareaRef: { current: null } as RefObject<HTMLTextAreaElement>,
    completionItems: [] as readonly string[],
    selectedIndex: 0,
    popupPos: { top: 0, left: 0 },
    handleChange: (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value),
    handleKeyDown: (_e: KeyboardEvent<HTMLTextAreaElement>) => {},
    applyCompletion: (_item: string) => {},
  }),
}));

const rows = [
  { _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', aid: 'w-1' },
  { _id: 1102025811, aid: 'w-2' },
];

describe('MongoDocumentList', () => {
  it('渲染每个文档一张卡片', () => {
    render(<MongoDocumentList rows={rows} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getAllByText('aid')).toHaveLength(2);
  });

  it('composing 时顶部渲染新建编辑器, 列表照常', () => {
    render(
      <MongoDocumentList
        rows={rows} view="list" composing={{}} fieldNames={[]}
        onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()}
        onSave={vi.fn()} onCancelEdit={vi.fn()}
      />,
    );
    expect(document.querySelector('.mongo-doc-card-composing')).not.toBeNull();
    expect(document.querySelector('.highlight-editor-textarea')).not.toBeNull();
    // 列表中两张文档卡片仍在 (列表不动)
    expect(screen.getAllByText('aid')).toHaveLength(2);
  });

  it('editingId 命中的行内联编辑, 其它行仍是树', () => {
    render(
      <MongoDocumentList
        rows={rows} view="list" editingId={'1102025811'} fieldNames={[]}
        onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()}
        onSave={vi.fn()} onCancelEdit={vi.fn()}
      />,
    );
    // 仅 1 个编辑器 (命中的行), 另一行仍渲染树 (有 1 个 aid 文本)
    expect(document.querySelectorAll('.highlight-editor-textarea')).toHaveLength(1);
    expect(screen.getAllByText('aid')).toHaveLength(1);
  });
});
