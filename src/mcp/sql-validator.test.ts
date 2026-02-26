import { describe, it, expect } from 'vitest';
import { isReadonlySQL, enforceLimit } from './sql-validator.js';

describe('isReadonlySQL', () => {
  // 合法的只读语句
  const validCases = [
    'SELECT * FROM users',
    'select id, name from users where id = 1',
    'SELECT count(*) FROM orders',
    'SHOW DATABASES',
    'SHOW TABLES',
    'show create table users',
    'DESCRIBE users',
    'DESC users',
    'EXPLAIN SELECT * FROM users',
    "WITH cte AS (SELECT 1) SELECT * FROM cte",
    "SELECT * FROM users WHERE name = 'hello;world'", // 字符串中的分号
    '  SELECT * FROM users  ', // 前后空格
  ];

  for (const sql of validCases) {
    it(`should allow: ${sql.slice(0, 50)}`, () => {
      expect(isReadonlySQL(sql)).toBe(true);
    });
  }

  // 非法语句
  const invalidCases = [
    ['INSERT INTO users VALUES (1)', 'INSERT'],
    ['UPDATE users SET name = "x"', 'UPDATE'],
    ['DELETE FROM users', 'DELETE'],
    ['DROP TABLE users', 'DROP'],
    ['CREATE TABLE foo (id INT)', 'CREATE'],
    ['ALTER TABLE users ADD COLUMN age INT', 'ALTER'],
    ['TRUNCATE TABLE users', 'TRUNCATE'],
    ['SELECT * INTO OUTFILE "/tmp/x" FROM users', 'SELECT INTO'],
    ['SELECT 1; DROP TABLE users', 'multi-statement'],
    ['GRANT ALL ON *.* TO root', 'GRANT'],
  ];

  for (const [sql, reason] of invalidCases) {
    it(`should reject ${reason}: ${sql.slice(0, 50)}`, () => {
      expect(isReadonlySQL(sql)).toBe(false);
    });
  }

  it('should allow single statement with trailing semicolon', () => {
    expect(isReadonlySQL('SELECT 1;')).toBe(true);
  });

  it('should reject multi-statement even with whitespace', () => {
    expect(isReadonlySQL('SELECT 1;  SELECT 2')).toBe(false);
  });
});

describe('enforceLimit', () => {
  it('should append LIMIT 500 to SELECT without limit', () => {
    expect(enforceLimit('SELECT * FROM users')).toBe('SELECT * FROM users LIMIT 500');
  });

  it('should keep existing LIMIT if <= 500', () => {
    expect(enforceLimit('SELECT * FROM users LIMIT 100')).toBe('SELECT * FROM users LIMIT 100');
  });

  it('should reduce LIMIT if > 500', () => {
    expect(enforceLimit('SELECT * FROM users LIMIT 9999')).toBe('SELECT * FROM users LIMIT 500');
  });

  it('should use requested limit if < 500', () => {
    expect(enforceLimit('SELECT * FROM users', 50)).toBe('SELECT * FROM users LIMIT 50');
  });

  it('should cap requested limit at 500', () => {
    expect(enforceLimit('SELECT * FROM users', 1000)).toBe('SELECT * FROM users LIMIT 500');
  });

  it('should not add LIMIT to SHOW', () => {
    expect(enforceLimit('SHOW TABLES')).toBe('SHOW TABLES');
  });

  it('should not add LIMIT to DESCRIBE', () => {
    expect(enforceLimit('DESCRIBE users')).toBe('DESCRIBE users');
  });

  it('should not add LIMIT to EXPLAIN', () => {
    expect(enforceLimit('EXPLAIN SELECT * FROM users')).toBe('EXPLAIN SELECT * FROM users');
  });

  it('should strip trailing semicolon before appending LIMIT', () => {
    expect(enforceLimit('SELECT * FROM users;')).toBe('SELECT * FROM users LIMIT 500');
  });
});
