import { describe, it, expect } from 'vitest';
import { formatSql } from './format-sql';

describe('formatSql', () => {
  it('mysql 走 sql-formatter', () => {
    const result = formatSql('select * from users', 'mysql');
    expect(result).toContain('SELECT');
  });
});
