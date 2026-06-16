import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ViewToggle } from './ViewToggle';

describe('ViewToggle', () => {
  it('点 JSON 触发 onChange(json)', () => {
    const onChange = vi.fn();
    render(<ViewToggle value="list" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /json/i }));
    expect(onChange).toHaveBeenCalledWith('json');
  });

  it('当前视图按钮标记 aria-pressed', () => {
    render(<ViewToggle value="table" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /table/i })).toHaveAttribute('aria-pressed', 'true');
  });
});
