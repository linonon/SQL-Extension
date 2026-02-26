import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 内联测试 query tool 的校验逻辑
// 因为 tool 注册在 McpServer 上, 直接测试 sql-validator + connection-pool 集成

import { isReadonlySQL, enforceLimit } from '../sql-validator.js';

describe('query tool - SQL validation integration', () => {
  it('should reject INSERT via isReadonlySQL', () => {
    expect(isReadonlySQL('INSERT INTO users VALUES (1, "test")')).toBe(false);
  });

  it('should reject UPDATE via isReadonlySQL', () => {
    expect(isReadonlySQL('UPDATE users SET name = "x" WHERE id = 1')).toBe(false);
  });

  it('should reject DELETE via isReadonlySQL', () => {
    expect(isReadonlySQL('DELETE FROM users WHERE id = 1')).toBe(false);
  });

  it('should reject DROP TABLE via isReadonlySQL', () => {
    expect(isReadonlySQL('DROP TABLE users')).toBe(false);
  });

  it('should reject multi-statement injection', () => {
    expect(isReadonlySQL('SELECT 1; DROP TABLE users;')).toBe(false);
  });

  it('should allow SELECT and enforce LIMIT', () => {
    expect(isReadonlySQL('SELECT * FROM users')).toBe(true);
    const limited = enforceLimit('SELECT * FROM users');
    expect(limited).toBe('SELECT * FROM users LIMIT 500');
  });

  it('should allow WITH CTE queries', () => {
    const sql = 'WITH active AS (SELECT * FROM users WHERE active = true) SELECT * FROM active';
    expect(isReadonlySQL(sql)).toBe(true);
    const limited = enforceLimit(sql);
    expect(limited).toContain('LIMIT 500');
  });

  it('should cap user-specified LIMIT at 500', () => {
    const sql = 'SELECT * FROM users LIMIT 99999';
    expect(isReadonlySQL(sql)).toBe(true);
    const limited = enforceLimit(sql);
    expect(limited).toBe('SELECT * FROM users LIMIT 500');
  });
});
