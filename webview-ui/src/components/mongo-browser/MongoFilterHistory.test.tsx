import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  mergeFilterHistory,
  isRecordableQuery,
  MongoFilterHistory,
  type FilterHistoryEntry,
} from './MongoFilterHistory';

function entry(filter: string, ts = 1): FilterHistoryEntry {
  return { filter, sort: '', projection: '', timestamp: ts };
}

describe('isRecordableQuery', () => {
  it('全空不记录', () => {
    expect(isRecordableQuery('', '', '')).toBe(false);
    expect(isRecordableQuery('  ', ' ', '')).toBe(false);
  });
  it('任一非空即可记录', () => {
    expect(isRecordableQuery('{a:1}', '', '')).toBe(true);
    expect(isRecordableQuery('', '{a:-1}', '')).toBe(true);
  });
});

describe('mergeFilterHistory', () => {
  it('新条目置顶, 旧的相同 (filter+sort+projection) 去重', () => {
    const prev = [entry('{a:1}', 1), entry('{b:2}', 2)];
    const next = mergeFilterHistory(prev, entry('{a:1}', 3), 30);
    expect(next.map((e) => e.filter)).toEqual(['{a:1}', '{b:2}']);
    expect(next[0].timestamp).toBe(3);
  });
  it('截断到 max', () => {
    const prev = Array.from({ length: 30 }, (_, i) => entry(`{n:${i}}`, i));
    const next = mergeFilterHistory(prev, entry('{new:1}', 99), 30);
    expect(next).toHaveLength(30);
    expect(next[0].filter).toBe('{new:1}');
  });
});

describe('MongoFilterHistory 组件', () => {
  it('空历史显示占位', () => {
    render(<MongoFilterHistory entries={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/no query history/i)).toBeInTheDocument();
  });
  it('点击条目回调该条目', () => {
    const onSelect = vi.fn();
    const e = { filter: '{status:"active"}', sort: '{_id:-1}', projection: '', timestamp: 5 };
    render(<MongoFilterHistory entries={[e]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('{status:"active"}'));
    expect(onSelect).toHaveBeenCalledWith(e);
  });
});
