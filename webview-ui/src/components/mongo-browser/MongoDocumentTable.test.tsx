import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';
import { MongoDocumentTable } from './MongoDocumentTable';

// 卡片编辑器 / filter 输入用 autocomplete hook, mock 掉避免 DOM 测量
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

const col = (name: string) => ({ name, dataType: 'string', nullable: true, isPrimaryKey: name === '_id', defaultValue: null, extra: '' });

function renderTable(over: Record<string, unknown> = {}) {
  const props = {
    collection: 'users',
    columns: [col('_id'), col('name')],
    rows: [{ _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', name: 'Alice' }],
    total: 1,
    loading: false,
    page: 0,
    pageSize: 50,
    filter: '',
    sort: '',
    projection: '',
    customLimit: '',
    customSkip: '',
    onFilterChange: vi.fn(),
    onSortChange: vi.fn(),
    onProjectionChange: vi.fn(),
    onLimitChange: vi.fn(),
    onSkipChange: vi.fn(),
    onApply: vi.fn(),
    onPageChange: vi.fn(),
    onInsertDocument: vi.fn(),
    onUpdateDocument: vi.fn(),
    onUpdateField: vi.fn(),
    onDeleteDocument: vi.fn(),
    queryError: null,
    ...over,
  };
  return { props, ...render(<MongoDocumentTable {...(props as any)} />) };
}

beforeEach(() => vi.clearAllMocks());

describe('MongoDocumentTable - 渲染保护 (H8/P3a)', () => {
  it('rows 超过 200 时显示性能保护提示, 仅渲染前 200', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ _id: `ObjectId("${String(i).padStart(24, '0')}")`, name: `u${i}` }));
    renderTable({ rows, total: 250 });
    expect(screen.getByText(/性能保护/)).toBeInTheDocument();
    // 卡片数量被截断到 200
    expect(document.querySelectorAll('.mongo-doc-card').length).toBe(200);
  });

  it('rows 不超过 200 时无提示', () => {
    renderTable();
    expect(screen.queryByText(/性能保护/)).toBeNull();
  });
});

describe('MongoDocumentTable - 下拉互斥 (M10)', () => {
  it('打开 Builder 再打开 History 时 Builder 关闭', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: /Filter builder/i }));
    expect(document.querySelector('.mongo-filter-builder-dropdown')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Query history/i }));
    expect(document.querySelector('.mongo-filter-history-dropdown')).not.toBeNull();
    expect(document.querySelector('.mongo-filter-builder-dropdown')).toBeNull();
  });
});

describe('MongoDocumentTable - 脏数据守卫 (H6)', () => {
  it('编辑器脏时点 Apply 弹未保存对话框, Discard 后才执行 Apply', () => {
    const onApply = vi.fn();
    renderTable({ onApply });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name":"changed"}' } });

    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(/未保存的修改/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Discard'));
    expect(onApply).toHaveBeenCalled();
  });

  it('GAP1: 对话框 Save 内容有效 -> 先保存 (onUpdateDocument) 再执行挂起的 Apply', () => {
    const onApply = vi.fn();
    const onUpdateDocument = vi.fn();
    renderTable({ onApply, onUpdateDocument });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name":"ok"}' } });

    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    const dialog = document.querySelector('.mongo-nav-dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByText('Save'));

    expect(onUpdateDocument).toHaveBeenCalled();
    expect(onApply).toHaveBeenCalled();
  });

  it('round2 #3: 对话框 Save 但内容非法保存失败 -> 挂起的 Apply 取消, 后续手动保存不触发它', () => {
    const onApply = vi.fn();
    const onUpdateDocument = vi.fn();
    renderTable({ onApply, onUpdateDocument });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{invalid json' } });

    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    const dialog = document.querySelector('.mongo-nav-dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByText('Save'));
    // 保存失败 (非法 JSON): 既没更新, Apply 也没触发
    expect(onUpdateDocument).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    // 修好内容 + 手动 Save (编辑器自身按钮) -> 更新成功, 但被取消的 Apply 不应被触发
    fireEvent.change(textarea, { target: { value: '{"name":"ok"}' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onUpdateDocument).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('编辑器脏时翻页弹对话框, Cancel 不翻页', () => {
    const onPageChange = vi.fn();
    renderTable({ onPageChange, total: 200, page: 0 });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name":"changed"}' } });

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(onPageChange).not.toHaveBeenCalled();
    const dialog = document.querySelector('.mongo-nav-dialog') as HTMLElement;
    expect(dialog).not.toBeNull();
    fireEvent.click(within(dialog).getByText('Cancel'));
    expect(onPageChange).not.toHaveBeenCalled();
  });
});

describe('MongoDocumentTable - handleSave insert/update 分流 (H8)', () => {
  it('New Document 保存走 insert', () => {
    const onInsertDocument = vi.fn();
    renderTable({ onInsertDocument });
    fireEvent.click(screen.getByRole('button', { name: /New Document/i }));
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name": "new"}' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onInsertDocument).toHaveBeenCalledWith({ name: 'new' });
  });
});
