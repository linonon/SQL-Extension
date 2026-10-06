import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RedisStringEditor } from './RedisStringEditor';

describe('RedisStringEditor', () => {
  it('加载时原样显示, Format JSON 无损格式化 (int64 / 1.50 不变)', () => {
    const raw = '{"uid":1234567890123456789,"gold":1.50}';
    render(<RedisStringEditor value={raw} onSave={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe(raw);

    fireEvent.click(screen.getByText('Format JSON'));
    expect(textarea.value).toBe('{\n  "uid": 1234567890123456789,\n  "gold": 1.50\n}');
  });

  it('已是 pretty 的 JSON 也显示 Format JSON, 非 JSON 不显示', () => {
    const { rerender } = render(<RedisStringEditor value={'{\n  "a": 1\n}'} onSave={vi.fn()} />);
    expect(screen.getByText('Format JSON')).toBeInTheDocument();
    rerender(<RedisStringEditor value="plain text" onSave={vi.fn()} />);
    expect(screen.queryByText('Format JSON')).toBeNull();
  });
});
