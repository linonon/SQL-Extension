import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// db_read / db_execute 在扩展侧的校验: sql-validator 与 routeByDriver

import { isReadonlySQL, enforceLimit } from './sql-validator.js';

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
    expect(limited).toBe('SELECT * FROM users\nLIMIT 500');
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

import { routeByDriver, type DriverSource } from './query-router.js';
import type { ToolResult } from '../mcp/tools/mcp-result.js';

const isErr = (r: ToolResult) => 'isError' in r && r.isError === true;

describe('routeByDriver SQL guards', () => {
  const ok = { columns: [], rows: [{ n: 1 }], affectedRows: 0, executionTime: 1 };
  function source() {
    const driver = {
      executeReadOnly: vi.fn().mockResolvedValue(ok),
      executeCancellable: vi.fn().mockReturnValue({ promise: Promise.resolve(ok), cancel: () => {} }),
      execute: vi.fn().mockResolvedValue(ok),
    };
    return { driver, src: { getDriver: () => driver } as unknown as DriverSource };
  }

  it('runs reads through executeReadOnly with the capped query', async () => {
    const { driver, src } = source();
    const r = await routeByDriver('read', 'mysql', 'c', 'SELECT * FROM t', 'db1', src);
    expect(isErr(r)).toBe(false);
    expect(driver.executeReadOnly).toHaveBeenCalledWith('SELECT * FROM t\nLIMIT 500', 'db1');
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('rejects writes in read mode before touching the driver', async () => {
    const { driver, src } = source();
    const r = await routeByDriver('read', 'postgresql', 'c', 'DELETE FROM t', undefined, src);
    expect(isErr(r)).toBe(true);
    expect(driver.executeReadOnly).not.toHaveBeenCalled();
  });

  it('requires a database for MySQL execute', async () => {
    const { driver, src } = source();
    const r = await routeByDriver('execute', 'mysql', 'c', 'DELETE FROM t WHERE id=1', undefined, src);
    expect(isErr(r)).toBe(true);
    expect(driver.executeCancellable).not.toHaveBeenCalled();
    await routeByDriver('execute', 'mysql', 'c', 'DELETE FROM t WHERE id=1', 'db1', src);
    expect(driver.executeCancellable).toHaveBeenCalledWith('DELETE FROM t WHERE id=1', undefined, 'db1');
  });
});
