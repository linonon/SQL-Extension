import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataGridPagination } from './DataGridPagination';
import type { PageInfo } from '../../types/database';

describe('DataGridPagination', () => {
  it('应该正确显示第一页的分页信息', () => {
    const page: PageInfo = { offset: 0, limit: 100, total: 250 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    expect(screen.getByText('Rows 1-100 of 250')).toBeInTheDocument();
    expect(screen.getByText('Page 1 / 3')).toBeInTheDocument();
  });

  it('应该正确显示中间页的分页信息', () => {
    const page: PageInfo = { offset: 100, limit: 100, total: 250 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    expect(screen.getByText('Rows 101-200 of 250')).toBeInTheDocument();
    expect(screen.getByText('Page 2 / 3')).toBeInTheDocument();
  });

  it('应该正确显示最后一页的分页信息 (不足 limit 条)', () => {
    const page: PageInfo = { offset: 200, limit: 100, total: 250 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    expect(screen.getByText('Rows 201-250 of 250')).toBeInTheDocument();
    expect(screen.getByText('Page 3 / 3')).toBeInTheDocument();
  });

  it('应该在没有数据时显示 "No rows"', () => {
    const page: PageInfo = { offset: 0, limit: 100, total: 0 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    expect(screen.getByText('No rows')).toBeInTheDocument();
    expect(screen.getByText('Page 1 / 1')).toBeInTheDocument();
  });

  it('应该在第一页时禁用 First 和 Prev 按钮', () => {
    const page: PageInfo = { offset: 0, limit: 100, total: 300 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    expect(screen.getByText('First')).toBeDisabled();
    expect(screen.getByText('Prev')).toBeDisabled();
    expect(screen.getByText('Next')).not.toBeDisabled();
    expect(screen.getByText('Last')).not.toBeDisabled();
  });

  it('应该在最后一页时禁用 Next 和 Last 按钮', () => {
    const page: PageInfo = { offset: 200, limit: 100, total: 250 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    expect(screen.getByText('First')).not.toBeDisabled();
    expect(screen.getByText('Prev')).not.toBeDisabled();
    expect(screen.getByText('Next')).toBeDisabled();
    expect(screen.getByText('Last')).toBeDisabled();
  });

  it('应该在点击 First 按钮时调用 onPageChange(0)', () => {
    const page: PageInfo = { offset: 100, limit: 100, total: 300 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByText('First'));

    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('应该在点击 Prev 按钮时调用 onPageChange(offset - limit)', () => {
    const page: PageInfo = { offset: 200, limit: 100, total: 500 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByText('Prev'));

    expect(onPageChange).toHaveBeenCalledWith(100);
  });

  it('应该在点击 Next 按钮时调用 onPageChange(offset + limit)', () => {
    const page: PageInfo = { offset: 100, limit: 100, total: 300 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByText('Next'));

    expect(onPageChange).toHaveBeenCalledWith(200);
  });

  it('应该在点击 Last 按钮时调用 onPageChange((totalPages - 1) * limit)', () => {
    const page: PageInfo = { offset: 0, limit: 100, total: 350 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByText('Last'));

    // totalPages = Math.ceil(350 / 100) = 4
    // lastOffset = (4 - 1) * 100 = 300
    expect(onPageChange).toHaveBeenCalledWith(300);
  });

  it('应该在只有一页数据时禁用所有分页按钮', () => {
    const page: PageInfo = { offset: 0, limit: 100, total: 50 };
    const onPageChange = vi.fn();

    render(<DataGridPagination page={page} onPageChange={onPageChange} />);

    expect(screen.getByText('First')).toBeDisabled();
    expect(screen.getByText('Prev')).toBeDisabled();
    expect(screen.getByText('Next')).toBeDisabled();
    expect(screen.getByText('Last')).toBeDisabled();
  });
});
