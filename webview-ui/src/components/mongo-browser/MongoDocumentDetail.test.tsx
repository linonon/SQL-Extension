import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MongoDocumentDetail } from './MongoDocumentDetail';
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';

// mock useMongoAutocomplete - 避免 DOM 测量
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

const defaultProps = {
  fieldNames: [] as string[],
  onClose: vi.fn(),
  onSave: vi.fn(),
  onDelete: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MongoDocumentDetail - save 流程', () => {
  it('J1: edit 模式未修改 -> Save 按钮 disabled', () => {
    const doc = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'test' };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" />);
    const saveBtn = screen.getByText('Save');
    expect(saveBtn).toBeDisabled();
  });

  it('J2: edit 模式修改文本 -> Save -> onSave(打开时的文档, 编辑结果), 都不含 _id', () => {
    const onSave = vi.fn();
    const doc = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'test' };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" onSave={onSave} />);

    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name": "updated"}' } });

    const saveBtn = screen.getByText('Save');
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    expect(onSave).toHaveBeenCalledWith({ name: 'test' }, { name: 'updated' });
  });

  it('J3: insert 模式 -> Save -> onSave(null, parsed)', () => {
    const onSave = vi.fn();
    render(<MongoDocumentDetail {...defaultProps} document={null} mode="insert" onSave={onSave} />);

    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name": "new"}' } });

    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith(null, { name: 'new' });
  });

  it('J4: 无效 JSON -> 显示 error, Save 禁用, 不调用 onSave', () => {
    const onSave = vi.fn();
    render(<MongoDocumentDetail {...defaultProps} document={null} mode="insert" onSave={onSave} />);

    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{invalid json' } });

    const saveBtn = screen.getByText('Save');
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector('.detail-error')).not.toBeNull();
  });

  it('J4b: 非法 ISODate 值 -> Save 禁用 + 错误 (防静默写 epoch 0)', () => {
    const onSave = vi.fn();
    const doc = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'x' };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" onSave={onSave} />);
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{ "d": ISODate("2026-04-07sdT02:56:51.053Z") }' } });
    expect(screen.getByText('Save')).toBeDisabled();
    expect(document.querySelector('.detail-error')?.textContent ?? '').toMatch(/日期|date/i);
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('J5: P0 round-trip ObjectId - shell 展示 -> save 时类型标记保留', () => {
    const onSave = vi.fn();
    // 模拟后端返回的 document (value 是 shell 语法字符串, 存储在 JS object 中)
    const doc = {
      _id: 'ObjectId("507f1f77bcf86cd799439011")',
      name: 'test',
    };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" onSave={onSave} />);

    // textarea 初始值由 jsonToShell(JSON.stringify(stripId(doc))) 生成
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    const displayText = textarea.value;

    // 修改一下触发 dirty, 然后改回带 ObjectId 的内容
    const shellDoc = '{\n  "name": "test",\n  "ref": ObjectId("aabbccddeeff00112233aabb")\n}';
    fireEvent.change(textarea, { target: { value: shellDoc } });
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      { name: 'test' },
      { name: 'test', ref: { '$oid': 'aabbccddeeff00112233aabb' } }
    );
  });

  it('J6: round-trip ISODate', () => {
    const onSave = vi.fn();
    const doc = { _id: 'myid', name: 'test' };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" onSave={onSave} />);

    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"date": ISODate("2024-01-15T00:00:00.000Z")}' } });
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith({ name: 'test' }, { date: { '$date': '2024-01-15T00:00:00.000Z' } });
  });

  it('J7: round-trip NumberLong', () => {
    const onSave = vi.fn();
    const doc = { _id: 'myid', name: 'test' };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" onSave={onSave} />);

    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"big": NumberLong("9999999999")}' } });
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith({ name: 'test' }, { big: { '$numberLong': '9999999999' } });
  });

  it('超出 2^53 的裸整数不被 JSON.parse 舍入, 按 $numberLong 提交', () => {
    const onSave = vi.fn();
    render(<MongoDocumentDetail {...defaultProps} document={{ _id: 'myid', name: 'test' }} mode="edit" onSave={onSave} />);
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"uid": 9007199254740993, "n": 5, "s": "9007199254740993"}' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith(
      { name: 'test' },
      { uid: { $numberLong: '9007199254740993' }, n: 5, s: '9007199254740993' },
    );
  });

  it('整数值的大 Double (1e20) 打开即可校验通过, 改别的字段时两边该值相同', () => {
    const onSave = vi.fn();
    render(<MongoDocumentDetail {...defaultProps} document={{ _id: 'myid', score: 1e20, n: 1 }} mode="edit" onSave={onSave} />);
    expect(document.querySelector('.detail-error')).toBeNull();
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: textarea.value.replace('"n": 1', '"n": 2') } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith({ score: 1e20, n: 1 }, { score: 1e20, n: 2 });
  });

  it('打开后列表刷新换了 document 对象, 对比基准仍是打开时的文档', () => {
    const onSave = vi.fn();
    const { rerender } = render(<MongoDocumentDetail {...defaultProps} document={{ _id: 'myid', gold: 1 }} mode="edit" onSave={onSave} />);
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"gold": 1, "name": "x"}' } });
    rerender(<MongoDocumentDetail {...defaultProps} document={{ _id: 'myid', gold: 999 }} mode="edit" onSave={onSave} />);
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith({ gold: 1 }, { gold: 1, name: 'x' });
  });

  it('J8: round-trip 混合类型文档', () => {
    const onSave = vi.fn();
    const doc = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'test' };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" onSave={onSave} />);

    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    const mixedDoc = '{"name": "test", "ref": ObjectId("aabbccddeeff00112233aabb"), "date": ISODate("2024-01-15T00:00:00.000Z"), "count": NumberInt(42), "big": NumberLong("999"), "price": NumberDecimal("19.99"), "lo": MinKey(), "hi": MaxKey()}';
    fireEvent.change(textarea, { target: { value: mixedDoc } });
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith({ name: 'test' }, {
      name: 'test',
      ref: { '$oid': 'aabbccddeeff00112233aabb' },
      date: { '$date': '2024-01-15T00:00:00.000Z' },
      count: { '$numberInt': '42' },
      big: { '$numberLong': '999' },
      price: { '$numberDecimal': '19.99' },
      lo: { '$minKey': 1 },
      hi: { '$maxKey': 1 },
    });
  });
});

describe('MongoDocumentDetail - clone', () => {
  it('J9: insert + seed 含 _id (clone) -> _id 在编辑区可改, save 带上 seed 作对比基准', () => {
    const onSave = vi.fn();
    const seed = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'orig' };
    render(<MongoDocumentDetail {...defaultProps} document={seed} mode="insert" onSave={onSave} />);

    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    // seed 的 _id 不被 strip, 出现在可编辑文本里
    expect(textarea.value).toContain('_id');

    fireEvent.change(textarea, {
      target: { value: '{"_id": ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"), "name": "clone"}' },
    });
    fireEvent.click(screen.getByText('Save'));

    // original 是 seed (含源 _id), doc 含改过的 _id (EJSON)
    expect(onSave).toHaveBeenCalledWith(
      { _id: { '$oid': '507f1f77bcf86cd799439011' }, name: 'orig' },
      { _id: { '$oid': 'aaaaaaaaaaaaaaaaaaaaaaaa' }, name: 'clone' },
    );
  });
});

describe('MongoDocumentDetail - UX 改进', () => {
  it('U1: _id 行有 read-only 标记 + Copy _id 按钮 (复制 shell 形式)', () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const doc = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'test' };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" />);

    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /copy _id/i }));
    expect(writeText).toHaveBeenCalledWith('ObjectId("507f1f77bcf86cd799439011")');
  });

  it('U2: 编辑产生改动时显示 unsaved changes 提示, 无改动时不显示', () => {
    const doc = { _id: 'ObjectId("507f1f77bcf86cd799439011")', name: 'test' };
    render(<MongoDocumentDetail {...defaultProps} document={doc} mode="edit" />);

    expect(screen.queryByText(/unsaved/i)).toBeNull();
    const textarea = document.querySelector('.highlight-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"name": "changed"}' } });
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
  });
});
