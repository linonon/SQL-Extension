import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryResults } from './QueryResults';
import type { ColumnInfo } from '../../types/database';

describe('QueryResults', () => {
  it('应该在有错误时显示错误消息', () => {
    const props = {
      columns: [],
      rows: [],
      affectedRows: 0,
      executionTime: 0,
      error: 'Syntax error near SELECT',
    };

    render(<QueryResults {...props} />);

    expect(screen.getByText('Syntax error near SELECT')).toBeInTheDocument();
    expect(screen.queryByText(/rows returned/)).not.toBeInTheDocument();
  });

  it('应该在没有返回行时显示 affectedRows 信息', () => {
    const props = {
      columns: [],
      rows: [],
      affectedRows: 5,
      executionTime: 42,
      error: undefined,
    };

    render(<QueryResults {...props} />);

    expect(screen.getByText('5 rows affected in 42ms')).toBeInTheDocument();
  });

  it('应该在有返回行时显示表格和行数信息', () => {
    const columns: ColumnInfo[] = [
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
      { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
    ];

    const rows = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];

    const props = {
      columns,
      rows,
      affectedRows: 0,
      executionTime: 15,
      error: undefined,
    };

    render(<QueryResults {...props} />);

    expect(screen.getByText('2 rows returned in 15ms')).toBeInTheDocument();

    // 检查表头
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('name')).toBeInTheDocument();

    // 检查数据行
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('应该在单元格值为 null 时显示 NULL', () => {
    const columns: ColumnInfo[] = [
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
      { name: 'email', dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
    ];

    const rows = [
      { id: 1, email: null },
      { id: 2, email: undefined },
    ];

    const props = {
      columns,
      rows,
      affectedRows: 0,
      executionTime: 10,
      error: undefined,
    };

    render(<QueryResults {...props} />);

    // 应该有两个 NULL 单元格
    const nullCells = screen.getAllByText('NULL');
    expect(nullCells).toHaveLength(2);

    // 检查 null 单元格有正确的 class
    nullCells.forEach((cell) => {
      expect(cell).toHaveClass('null-value');
    });
  });

  it('应该正确渲染多列数据', () => {
    const columns: ColumnInfo[] = [
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
      { name: 'username', dataType: 'varchar', nullable: false, isPrimaryKey: false, defaultValue: null, extra: '' },
      { name: 'email', dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      { name: 'age', dataType: 'int', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
    ];

    const rows = [
      { id: 1, username: 'alice', email: 'alice@example.com', age: 25 },
      { id: 2, username: 'bob', email: null, age: 30 },
    ];

    const props = {
      columns,
      rows,
      affectedRows: 0,
      executionTime: 20,
      error: undefined,
    };

    render(<QueryResults {...props} />);

    // 检查所有列名
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('username')).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
    expect(screen.getByText('age')).toBeInTheDocument();

    // 检查第一行数据
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();

    // 检查第二行数据
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('应该将非 null 值转换为字符串显示', () => {
    const columns: ColumnInfo[] = [
      { name: 'count', dataType: 'int', nullable: false, isPrimaryKey: false, defaultValue: null, extra: '' },
      { name: 'active', dataType: 'boolean', nullable: false, isPrimaryKey: false, defaultValue: null, extra: '' },
    ];

    const rows = [
      { count: 123, active: true },
      { count: 0, active: false },
    ];

    const props = {
      columns,
      rows,
      affectedRows: 0,
      executionTime: 5,
      error: undefined,
    };

    render(<QueryResults {...props} />);

    expect(screen.getByText('123')).toBeInTheDocument();
    expect(screen.getByText('true')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('false')).toBeInTheDocument();
  });

  it('应该在空结果时只显示执行信息不显示表格', () => {
    const props = {
      columns: [],
      rows: [],
      affectedRows: 0,
      executionTime: 8,
      error: undefined,
    };

    render(<QueryResults {...props} />);

    expect(screen.getByText('0 rows affected in 8ms')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
