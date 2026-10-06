import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RedisListEditor } from './RedisListEditor';

describe('RedisListEditor', () => {
  const props = () => ({
    value: ['a', 'b'],
    start: 100,
    total: 300,
    hasMore: true,
    onPush: vi.fn(),
    onRemove: vi.fn(),
    onBatchSet: vi.fn(),
    onLoadMore: vi.fn(),
  });

  it('Redis index 用 start + i: 显示, 删除, 批量 LSET 都对准真实元素', () => {
    const p = props();
    render(<RedisListEditor {...p} />);

    expect(screen.getByText('[101]')).toBeInTheDocument();
    fireEvent.click(screen.getAllByTitle('Remove item')[1]);
    expect(p.onRemove).toHaveBeenCalledWith(101);

    fireEvent.change(screen.getByDisplayValue('a'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Save All (1)'));
    expect(p.onBatchSet).toHaveBeenCalledWith([{ index: 100, value: 'x' }]);
  });

  it('有未保存编辑时 Load More 先就地确认, 取消不加载, 确认才加载', () => {
    const p = props();
    render(<RedisListEditor {...p} />);

    fireEvent.click(screen.getByText('Load More'));
    expect(p.onLoadMore).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByDisplayValue('a'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Load More'));
    expect(p.onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/discards 1 unsaved edit/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByDisplayValue('x')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Load More'));
    fireEvent.click(screen.getByText('Discard and Load More'));
    expect(p.onLoadMore).toHaveBeenCalledTimes(2);
  });

  it('确认中编辑被撤回 (待保存归零) 后收起确认, 再编辑不会不点 Load More 就弹出', () => {
    const p = props();
    render(<RedisListEditor {...p} />);

    fireEvent.change(screen.getByDisplayValue('a'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Load More'));
    expect(screen.getByText(/discards 1 unsaved edit/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Discard'));
    fireEvent.change(screen.getByDisplayValue('a'), { target: { value: 'y' } });
    expect(screen.queryByText(/discards/)).not.toBeInTheDocument();
    expect(screen.getByText('Load More')).toBeInTheDocument();
  });

  it('值框不吞换行; 展开后可无损格式化 JSON, 保存写回框里的原文', () => {
    const p = { ...props(), value: ['l1\nl2', '{"uid":1234567890123456789}'] };
    render(<RedisListEditor {...p} />);
    const first = document.querySelector('textarea.value') as HTMLTextAreaElement;
    expect(first.value).toBe('l1\nl2');
    fireEvent.change(first, { target: { value: 'l1\nl2\nl3' } });

    fireEvent.click(screen.getAllByTitle('Expand value')[1]);
    fireEvent.click(screen.getByText('Format JSON'));
    fireEvent.click(screen.getByText('Save All (2)'));
    expect(p.onBatchSet).toHaveBeenCalledWith([
      { index: 100, value: 'l1\nl2\nl3' },
      { index: 101, value: '{\n  "uid": 1234567890123456789\n}' },
    ]);
  });
});
