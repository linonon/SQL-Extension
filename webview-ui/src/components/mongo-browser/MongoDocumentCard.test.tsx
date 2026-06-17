import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';
import { MongoDocumentCard } from './MongoDocumentCard';

// 内联编辑器复用 MongoDocumentDetail, 需 mock autocomplete hook 避免 DOM 测量
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

  it('Delete 传去 _id 的 shell 形式 (保留类型, backend 还原)', () => {
    const onDelete = vi.fn();
    render(<MongoDocumentCard doc={{ _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', aid: 'w' }} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith('ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")');
  });

  it('Clone 按钮可用, 点击回调带完整文档 (含 _id)', () => {
    const onClone = vi.fn();
    render(<MongoDocumentCard doc={doc} view="list" onEdit={vi.fn()} onClone={onClone} onDelete={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /clone/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onClone).toHaveBeenCalledWith(doc);
  });

  it('editing 模式渲染内联编辑器 (列表不动), Save 调 onSave(idShell, doc)', () => {
    const onSave = vi.fn();
    render(
      <MongoDocumentCard
        doc={doc}
        view="list"
        editing
        fieldNames={[]}
        onEdit={vi.fn()}
        onClone={vi.fn()}
        onDelete={vi.fn()}
        onSave={onSave}
        onCancelEdit={vi.fn()}
      />,
    );
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea, { target: { value: '{"aid": "w-2"}' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith('ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', { aid: 'w-2' });
  });

  it('非 editing 模式不渲染编辑器, 渲染树', () => {
    render(<MongoDocumentCard doc={doc} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(document.querySelector('.highlight-editor-textarea')).toBeNull();
  });

  it('M7: 投影排除 _id 时 Edit/Clone/Delete 禁用 (无法定位文档)', () => {
    render(<MongoDocumentCard doc={{ aid: 'w-1' }} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('button', { name: /edit/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /clone/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
  });

  it('editing 默认 JSON 模式; 切到 Fields 模式渲染结构化字段编辑器', () => {
    render(
      <MongoDocumentCard
        doc={doc} view="list" editing fieldNames={[]}
        onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()}
        onSave={vi.fn()} onCancelEdit={vi.fn()}
      />,
    );
    // 默认 JSON: textarea 在, 字段编辑器不在
    expect(document.querySelector('.highlight-editor-textarea')).not.toBeNull();
    expect(document.querySelector('.mongo-fe')).toBeNull();
    // 切到 Fields
    fireEvent.click(screen.getByRole('button', { name: /^fields$/i }));
    expect(document.querySelector('.mongo-fe')).not.toBeNull();
    expect(document.querySelector('.highlight-editor-textarea')).toBeNull();
  });
});
