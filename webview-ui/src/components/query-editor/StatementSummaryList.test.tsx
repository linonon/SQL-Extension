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
        ]}
      />
    );
    expect(screen.getByText(/1\s+OK/)).toBeTruthy();
    expect(screen.getByText(/2\s+ERR/)).toBeTruthy();
    expect(screen.getByText(/3\s+skipped/)).toBeTruthy();
    expect(screen.getByText('syntax')).toBeTruthy();
  });
});
