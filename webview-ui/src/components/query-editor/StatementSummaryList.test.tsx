import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatementSummaryList } from './StatementSummaryList';

describe('StatementSummaryList', () => {
  it('renders ok/error/skipped rows', () => {
    render(
      <StatementSummaryList
        statements={[
          { index: 1, sql: 'ALTER TABLE a ADD c INT', status: 'ok', executionTime: 12, affectedRows: 0 },
          { index: 2, sql: 'ALTER TABLE b ADD c INT', status: 'error', error: 'syntax' },
          { index: 3, sql: 'ALTER TABLE c ADD c INT', status: 'skipped' },
          { index: 4, sql: 'SELECT * FROM a', status: 'ok', executionTime: 3, affectedRows: 0, rowCount: 42 },
        ]}
      />
    );
    // 结果集语句显示行数 (行本身不随回执下发), 写语句显示影响行数
    expect(screen.getByText('12ms · affected 0')).toBeTruthy();
    expect(screen.getByText('3ms · 42 rows')).toBeTruthy();
    expect(screen.getByText(/1\s+OK/)).toBeTruthy();
    expect(screen.getByText(/2\s+ERR/)).toBeTruthy();
    expect(screen.getByText(/3\s+skipped/)).toBeTruthy();
    expect(screen.getByText('syntax')).toBeTruthy();
  });
});
