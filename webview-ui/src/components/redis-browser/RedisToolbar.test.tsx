import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RedisToolbar } from './RedisToolbar';

const defaultDatabases = [
  { index: 0, keyCount: 5 },
  { index: 1, keyCount: 0 },
  { index: 3, keyCount: 12 },
];

describe('RedisToolbar', () => {
  const defaultProps = {
    database: 0,
    databases: defaultDatabases,
    commandText: '',
    onCommandTextChange: vi.fn(),
    onExecuteCommand: vi.fn(),
    onSearch: vi.fn(),
    onDatabaseChange: vi.fn(),
    onRefresh: vi.fn(),
    onAddKey: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应该渲染 textarea, Run 按钮, db select, Refresh, Add Key, Export, Import', () => {
    render(<RedisToolbar {...defaultProps} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByText('Run')).toBeInTheDocument();
    expect(screen.getByText('Export')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeInTheDocument();
    // Refresh 和 Add Key 是 icon 按钮, 用 title 查找
    expect(screen.getByTitle('Refresh')).toBeInTheDocument();
    expect(screen.getByTitle('Add Key')).toBeInTheDocument();
  });

  it('db select 正确渲染数据库列表', () => {
    render(<RedisToolbar {...defaultProps} />);

    expect(screen.getByDisplayValue('db0 (5)')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'db1 (0)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'db3 (12)' })).toBeInTheDocument();
  });

  it('输入 SCAN pattern 后点 Run 调用 onSearch', () => {
    render(<RedisToolbar {...defaultProps} commandText="user:*" />);

    fireEvent.click(screen.getByText('Run'));

    expect(defaultProps.onSearch).toHaveBeenCalledWith('user:*');
    expect(defaultProps.onExecuteCommand).not.toHaveBeenCalled();
  });

  it('输入 Redis 命令后点 Run 调用 onExecuteCommand', () => {
    render(<RedisToolbar {...defaultProps} commandText="GET mykey" />);

    fireEvent.click(screen.getByText('Run'));

    expect(defaultProps.onExecuteCommand).toHaveBeenCalledWith('GET mykey');
    expect(defaultProps.onSearch).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter 触发 Run', () => {
    render(<RedisToolbar {...defaultProps} commandText="test:*" />);

    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(defaultProps.onSearch).toHaveBeenCalledWith('test:*');
  });

  it('db 下拉 onChange 调用 onDatabaseChange', () => {
    render(<RedisToolbar {...defaultProps} />);

    const select = screen.getByDisplayValue('db0 (5)');
    fireEvent.change(select, { target: { value: '3' } });

    expect(defaultProps.onDatabaseChange).toHaveBeenCalledWith(3);
  });

  it('Refresh 按钮调用 onRefresh', () => {
    render(<RedisToolbar {...defaultProps} />);

    fireEvent.click(screen.getByTitle('Refresh'));

    expect(defaultProps.onRefresh).toHaveBeenCalled();
  });

  it('Add Key 按钮调用 onAddKey', () => {
    render(<RedisToolbar {...defaultProps} />);

    fireEvent.click(screen.getByTitle('Add Key'));

    expect(defaultProps.onAddKey).toHaveBeenCalled();
  });

  it('空 commandText 时 Run 调用 onSearch("*")', () => {
    render(<RedisToolbar {...defaultProps} commandText="" />);

    fireEvent.click(screen.getByText('Run'));

    expect(defaultProps.onSearch).toHaveBeenCalledWith('*');
  });

  it('空白 commandText 时 Run 调用 onSearch("*")', () => {
    render(<RedisToolbar {...defaultProps} commandText="   " />);

    fireEvent.click(screen.getByText('Run'));

    expect(defaultProps.onSearch).toHaveBeenCalledWith('*');
  });

  it('Export 按钮调用 onExport', () => {
    render(<RedisToolbar {...defaultProps} />);

    fireEvent.click(screen.getByText('Export'));

    expect(defaultProps.onExport).toHaveBeenCalled();
  });

  it('Import 按钮调用 onImport', () => {
    render(<RedisToolbar {...defaultProps} />);

    fireEvent.click(screen.getByText('Import'));

    expect(defaultProps.onImport).toHaveBeenCalled();
  });
});
