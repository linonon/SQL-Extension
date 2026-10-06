import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';
import { MongoDocumentTable } from './MongoDocumentTable';
import { convertShellToJson } from '../../utils/mongo-shell-to-json';

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
    offset: 0,
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
    onCloneDocument: vi.fn(),
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

describe('MongoDocumentTable - readOnly (projection 含子路径或表达式)', () => {
  it('readOnly 时 Edit/Clone 禁用带提示, Delete 仍可用; 表格视图不可原地编辑也不能打开', () => {
    renderTable({ readOnly: true });
    expect(screen.getByText(/Projection 含子路径或表达式/)).toBeInTheDocument();
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    fireEvent.doubleClick(screen.getByText('Alice'));
    expect(document.querySelector('.mongo-cell-input')).toBeNull();
    expect(screen.queryByRole('button', { name: /ObjectId/ })).toBeNull();
  });

  it('默认 (含顶层字段取舍的 projection) 可编辑, 无提示', () => {
    renderTable();
    expect(screen.queryByText(/Projection 含子路径或表达式/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clone' })).toBeEnabled();
  });
});

describe('MongoDocumentTable - Table 视图 (单击不切走, 双击原地编辑, _id 打开)', () => {
  it('单击, 单击, 双击 -> 原地编辑, 仍在 Table 视图; 点 _id 才切回 List 进入编辑', () => {
    const onUpdateDocument = vi.fn();
    renderTable({ onUpdateDocument });
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const cell = screen.getByText('Alice');
    fireEvent.click(cell);
    fireEvent.click(cell);
    fireEvent.doubleClick(cell);
    const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: 'Bob' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onUpdateDocument).toHaveBeenCalledWith({ $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, { name: 'Alice' }, { name: 'Bob' });
    expect(document.querySelector('.mongo-table')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")' }));
    expect(document.querySelector('.mongo-table')).toBeNull();
    expect(document.querySelector('.mongo-doc-card-editing')).not.toBeNull();
  });
});

describe('MongoDocumentTable - 分页 (偏移含 Skip, 总数可能未知)', () => {
  const twoRows = [
    { _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', name: 'Alice' },
    { _id: 'ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb")', name: 'Bob' },
  ];
  const next = () => screen.getByRole('button', { name: /^next$/i });

  it('范围标签从 offset 起算; 总数未知显示 ?, 本页取满时仍可 Next', () => {
    renderTable({ rows: twoRows, total: null, page: 1, offset: 12, pageSize: 2 });
    expect(screen.getByText('13-14 of ?')).toBeInTheDocument();
    expect(next()).toBeEnabled();
  });

  it('总数未知且本页没取满 -> 没有下一页', () => {
    renderTable({ total: null, offset: 12, pageSize: 2 });
    expect(next()).toBeDisabled();
  });

  it('总数已知: 到达总数后没有下一页', () => {
    renderTable({ rows: twoRows, total: 14, page: 1, offset: 12, pageSize: 2 });
    expect(screen.getByText('13-14 of 14')).toBeInTheDocument();
    expect(next()).toBeDisabled();
  });
});

describe('MongoDocumentTable - 输入框 placeholder', () => {
  it('Filter / Sort / Projection 的 placeholder 是后端能解析的写法', () => {
    renderTable();
    const placeholders = [...document.querySelectorAll('textarea.mongo-filter-input')].map((t) => t.getAttribute('placeholder')!);
    expect(placeholders).toHaveLength(3);
    for (const p of placeholders) { expect(() => JSON.parse(convertShellToJson(p))).not.toThrow(); }
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
    renderTable({ onPageChange, total: 200, page: 0, pageSize: 1 });
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

describe('MongoDocumentTable - 脏编辑器下编辑别的文档 / Clone / New / 切视图', () => {
  const twoRows = [
    { _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', name: 'Alice' },
    { _id: 'ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb")', name: 'Bob' },
  ];
  const dirtyEditOnFirst = () => {
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name":"changed"}' } });
    return textarea;
  };
  const cancelDialog = () => {
    const dialog = document.querySelector('.mongo-nav-dialog') as HTMLElement;
    expect(dialog).not.toBeNull();
    fireEvent.click(within(dialog).getByText('Cancel'));
  };

  it('四个动作都先弹未保存对话框, Cancel 后编辑内容保留', () => {
    renderTable({ rows: twoRows, total: 2 });
    const textarea = dirtyEditOnFirst();
    const viewToggle = within(screen.getByRole('group', { name: 'View mode' }));
    const actions = [
      screen.getByRole('button', { name: /^edit$/i }), // 第二张卡片 (第一张在编辑中, 不显示 Edit)
      screen.getAllByRole('button', { name: /^clone$/i })[0],
      screen.getByRole('button', { name: /New Document/i }),
      viewToggle.getByRole('button', { name: 'Table' }),
      viewToggle.getByRole('button', { name: 'JSON' }),
    ];
    for (const button of actions) {
      fireEvent.click(button);
      cancelDialog();
      expect(document.querySelector('.highlight-editor-textarea')).toBe(textarea);
      expect(textarea.value).toBe('{"name":"changed"}');
    }
  });

  it('Discard 后执行挂起的动作: 编辑另一张卡片', () => {
    renderTable({ rows: twoRows, total: 2 });
    dirtyEditOnFirst();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.click(within(document.querySelector('.mongo-nav-dialog') as HTMLElement).getByText('Discard'));
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('Bob');
  });
});

describe('MongoDocumentTable - handleSave insert/update/clone 分流', () => {
  const oid = { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' };

  it('Edit 保存走 update: _id 还原成 EJSON, 带打开时的文档作对比基准', () => {
    const onUpdateDocument = vi.fn();
    renderTable({ onUpdateDocument });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name": "Bob"}' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onUpdateDocument).toHaveBeenCalledWith(oid, { name: 'Alice' }, { name: 'Bob' });
  });

  it('Clone 保存走 clone: 源 _id 取自 seed, 不走 insert', () => {
    const onCloneDocument = vi.fn();
    const onInsertDocument = vi.fn();
    renderTable({ onCloneDocument, onInsertDocument });
    fireEvent.click(screen.getByRole('button', { name: /^clone$/i }));
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"_id": ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"), "name": "copy"}' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onCloneDocument).toHaveBeenCalledWith(oid, { _id: oid, name: 'Alice' }, { _id: oid, name: 'copy' });
    expect(onInsertDocument).not.toHaveBeenCalled();
  });

  it('表格单元格编辑走 update, 前后文档只含该 path (嵌套字段按层级展开)', () => {
    const onUpdateDocument = vi.fn();
    renderTable({
      onUpdateDocument,
      columns: [col('_id'), col('bag')],
      rows: [{ _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', bag: { gold: 10 } }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    fireEvent.click(screen.getByRole('button', { name: /expand bag/i }));
    fireEvent.doubleClick(screen.getByText('10'));
    const input = document.querySelector('.mongo-cell-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onUpdateDocument).toHaveBeenCalledWith(oid, { bag: { gold: 10 } }, { bag: { gold: 20 } });
  });

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
