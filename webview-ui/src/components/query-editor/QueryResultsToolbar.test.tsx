import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryResultsToolbar } from './QueryResultsToolbar';

const base = {
  rowCount: 50,
  executionTime: 1,
  editable: true,
  saving: false,
  onSave: () => {},
  onDiscard: () => {},
};

describe('QueryResultsToolbar', () => {
  it('有未保存编辑时显示 Discard, 点击触发 onDiscard', () => {
    const onDiscard = vi.fn();
    render(<QueryResultsToolbar {...base} pendingCount={1} onDiscard={onDiscard} />);
    const btn = screen.getByText('Discard');
    fireEvent.click(btn);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('无未保存编辑时不显示 Discard', () => {
    render(<QueryResultsToolbar {...base} pendingCount={0} />);
    expect(screen.queryByText('Discard')).not.toBeInTheDocument();
  });

  it('保存中 Discard 禁用', () => {
    render(<QueryResultsToolbar {...base} pendingCount={1} saving />);
    expect(screen.getByText('Discard')).toBeDisabled();
  });
});
