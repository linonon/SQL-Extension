import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';
import { MongoDocumentCard } from './MongoDocumentCard';
import { ReadOnlyContext } from '../../hooks/useReadOnly';

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

  it('只读连接: Edit / Clone / Delete 禁用, Copy 可用', () => {
    render(<ReadOnlyContext.Provider value={true}><MongoDocumentCard doc={doc} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} /></ReadOnlyContext.Provider>);
    for (const name of ['Edit', 'Clone', 'Delete']) {
      expect(screen.getByText(name)).toBeDisabled();
    }
    expect(screen.getByText('Copy')).not.toBeDisabled();
  });

  it('点 Edit 回调带文档', () => {
    const onEdit = vi.fn();
    render(<MongoDocumentCard doc={doc} view="list" onEdit={onEdit} onClone={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(doc);
  });

  it('Delete 传去 _id 的 EJSON 值 (保留类型)', () => {
    const onDelete = vi.fn();
    render(<MongoDocumentCard doc={{ _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', aid: 'w' }} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith({ $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  });

  it('复合 _id 内的 ObjectId / ISODate 也还原成 EJSON', () => {
    const onDelete = vi.fn();
    const _id = { uid: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', day: 'ISODate("2024-01-15T00:00:00.000Z")' };
    render(<MongoDocumentCard doc={{ _id, aid: 'w' }} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith({ uid: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, day: { $date: '2024-01-15T00:00:00.000Z' } });
  });

  it('Clone 按钮可用, 点击回调带完整文档 (含 _id)', () => {
    const onClone = vi.fn();
    render(<MongoDocumentCard doc={doc} view="list" onEdit={vi.fn()} onClone={onClone} onDelete={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /clone/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onClone).toHaveBeenCalledWith(doc);
  });

  it('editing 模式渲染内联编辑器 (列表不动), Save 调 onSave(original, doc)', () => {
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
    expect(onSave).toHaveBeenCalledWith({ aid: 'w-1' }, { aid: 'w-2' });
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

  it('Copy _id 复制 shell 写法 (复合 _id 里的 ISODate 不转义); 投影排除 _id 时禁用', () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const _id = { uid: 7, day: 'ISODate("2024-01-15T00:00:00.000Z")' };
    const { rerender } = render(<MongoDocumentCard doc={{ _id, aid: 'w' }} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy _id' }));
    expect(writeText).toHaveBeenCalledWith('{"uid":7,"day":ISODate("2024-01-15T00:00:00.000Z")}');
    rerender(<MongoDocumentCard doc={{ aid: 'w' }} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Copy _id' })).toBeDisabled();
  });

  it('List 视图渲染不 stringify 整篇文档, 点 Copy 时才生成 shell 文本', () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const spy = vi.spyOn(JSON, 'stringify');
    render(<MongoDocumentCard doc={doc} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(spy).not.toHaveBeenCalledWith(doc, null, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(spy).toHaveBeenCalledWith(doc, null, 2);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"aid": "w-1"'));
    spy.mockRestore();
  });
});
