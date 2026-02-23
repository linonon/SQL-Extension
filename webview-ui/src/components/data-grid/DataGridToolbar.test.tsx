import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataGridToolbar } from './DataGridToolbar';

describe('DataGridToolbar', () => {
  it('应该正确渲染表名和所有按钮', () => {
    const props = {
      tableName: 'users',
      onRefresh: vi.fn(),
      onInsert: vi.fn(),
      onDelete: vi.fn(),
      hasSelection: false,
    };

    render(<DataGridToolbar {...props} />);

    expect(screen.getByText('users')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Insert Row')).toBeInTheDocument();
    expect(screen.getByText('Delete Selected')).toBeInTheDocument();
  });

  it('应该在点击 Refresh 按钮时调用 onRefresh 回调', () => {
    const onRefresh = vi.fn();
    const props = {
      tableName: 'products',
      onRefresh,
      onInsert: vi.fn(),
      onDelete: vi.fn(),
      hasSelection: false,
    };

    render(<DataGridToolbar {...props} />);

    fireEvent.click(screen.getByText('Refresh'));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('应该在点击 Insert Row 按钮时调用 onInsert 回调', () => {
    const onInsert = vi.fn();
    const props = {
      tableName: 'orders',
      onRefresh: vi.fn(),
      onInsert,
      onDelete: vi.fn(),
      hasSelection: false,
    };

    render(<DataGridToolbar {...props} />);

    fireEvent.click(screen.getByText('Insert Row'));

    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('应该在 hasSelection 为 false 时禁用 Delete Selected 按钮', () => {
    const props = {
      tableName: 'customers',
      onRefresh: vi.fn(),
      onInsert: vi.fn(),
      onDelete: vi.fn(),
      hasSelection: false,
    };

    render(<DataGridToolbar {...props} />);

    const deleteButton = screen.getByText('Delete Selected');
    expect(deleteButton).toBeDisabled();
  });

  it('应该在 hasSelection 为 true 时启用 Delete Selected 按钮', () => {
    const props = {
      tableName: 'employees',
      onRefresh: vi.fn(),
      onInsert: vi.fn(),
      onDelete: vi.fn(),
      hasSelection: true,
    };

    render(<DataGridToolbar {...props} />);

    const deleteButton = screen.getByText('Delete Selected');
    expect(deleteButton).not.toBeDisabled();
  });

  it('应该在 hasSelection 为 true 且点击 Delete Selected 时调用 onDelete 回调', () => {
    const onDelete = vi.fn();
    const props = {
      tableName: 'posts',
      onRefresh: vi.fn(),
      onInsert: vi.fn(),
      onDelete,
      hasSelection: true,
    };

    render(<DataGridToolbar {...props} />);

    fireEvent.click(screen.getByText('Delete Selected'));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('应该在多次点击按钮时多次调用对应回调', () => {
    const onRefresh = vi.fn();
    const onInsert = vi.fn();
    const props = {
      tableName: 'comments',
      onRefresh,
      onInsert,
      onDelete: vi.fn(),
      hasSelection: false,
    };

    render(<DataGridToolbar {...props} />);

    fireEvent.click(screen.getByText('Refresh'));
    fireEvent.click(screen.getByText('Refresh'));
    fireEvent.click(screen.getByText('Insert Row'));

    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onInsert).toHaveBeenCalledTimes(1);
  });
});
