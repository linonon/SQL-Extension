import { describe, it, expect } from 'vitest';
import { isReadonlySQL, enforceLimit, isMultiStatement } from './sql-validator.js';

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
});

describe('enforceLimit', () => {
  it('should append LIMIT 500 to SELECT without limit', () => {
    expect(enforceLimit('SELECT * FROM users')).toBe('SELECT * FROM users\nLIMIT 500');
  });

  it('should keep existing LIMIT if <= 500', () => {
    expect(enforceLimit('SELECT * FROM users LIMIT 100')).toBe('SELECT * FROM users LIMIT 100');
  });

  it('should reduce LIMIT if > 500', () => {
    expect(enforceLimit('SELECT * FROM users LIMIT 9999')).toBe('SELECT * FROM users LIMIT 500');
  });

  it('should use requested limit if < 500', () => {
    expect(enforceLimit('SELECT * FROM users', 50)).toBe('SELECT * FROM users\nLIMIT 50');
  });

  it('should cap requested limit at 500', () => {
    expect(enforceLimit('SELECT * FROM users', 1000)).toBe('SELECT * FROM users\nLIMIT 500');
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
    expect(enforceLimit('SELECT * FROM users;')).toBe('SELECT * FROM users\nLIMIT 500');
  });
});

describe('isMultiStatement', () => {
  it('should return false for single statement', () => {
    expect(isMultiStatement('SELECT 1', 'mysql')).toBe(false);
  });
  it('should return false for trailing semicolon', () => {
    expect(isMultiStatement('SELECT 1;', 'mysql')).toBe(false);
  });
  it('should return true for multiple statements', () => {
    expect(isMultiStatement('SELECT 1; DROP TABLE users', 'mysql')).toBe(true);
  });
  it('should ignore semicolons in strings', () => {
    expect(isMultiStatement("SELECT * FROM t WHERE name = 'a;b'", 'mysql')).toBe(false);
  });
  it('注释里的 ; 不算分隔符, 两条真语句照样拒绝 (两种方言)', () => {
    for (const dialect of ['mysql', 'postgresql'] as const) {
      expect(isMultiStatement('SELECT 1 -- a; b', dialect)).toBe(false);
      expect(isMultiStatement('SELECT /* a; b */ 1;\n-- tail; x', dialect)).toBe(false);
      expect(isMultiStatement('SELECT 1;  SELECT 2', dialect)).toBe(true);
    }
  });
  it("反斜杠只在 MySQL 字符串里转义: PG 的 'a\\' 已结束, 其后的 DROP 是第二条语句", () => {
    const sql = "SELECT 'a\\'; DROP TABLE t; --'";
    expect(isMultiStatement(sql, 'postgresql')).toBe(true);
    expect(isMultiStatement(sql, 'mysql')).toBe(false);
    // PG 的 E'..' 认反斜杠
    expect(isMultiStatement("SELECT E'a\\'; DROP TABLE t; --'", 'postgresql')).toBe(false);
  });
  it('PG dollar quote 里的 ; 不切分: 函数体是一条语句', () => {
    const fn = 'CREATE FUNCTION f() RETURNS void AS $body$\nBEGIN\n  DELETE FROM t;\n  UPDATE u SET a = 1;\nEND;\n$body$ LANGUAGE plpgsql;';
    expect(isMultiStatement(fn, 'postgresql')).toBe(false);
    expect(isMultiStatement('DO $$ BEGIN PERFORM 1; END $$; SELECT 2', 'postgresql')).toBe(true);
  });
  it('PG 里 dollar quote / 嵌套块注释藏不住真分隔符', () => {
    // a$b$ 是标识符, 不是 dollar quote 的开头
    expect(isMultiStatement('SELECT 1 AS a$b$; DROP TABLE t; SELECT 1 AS c$b$', 'postgresql')).toBe(true);
    // 块注释在 PG 可嵌套: 注释到第二个 */ 才结束, 其后的 ' 不开字符串
    expect(isMultiStatement("SELECT 1 /* /* */ ' */; DROP TABLE t; --'", 'postgresql')).toBe(true);
  });
});

describe('read guard hardening', () => {
  it('rejects any INTO, including outside SELECT prefix', () => {
    expect(isReadonlySQL("SELECT \"'\" INTO OUTFILE '/tmp/x' -- '\"")).toBe(false);
    expect(isReadonlySQL('WITH a AS (SELECT 1) SELECT * INTO t FROM a')).toBe(false);
  });

  it('keeps LIMIT out of a trailing line comment', () => {
    expect(enforceLimit('SELECT * FROM t -- all')).toBe('SELECT * FROM t -- all\nLIMIT 500');
  });

  it('caps LIMIT n OFFSET m and LIMIT m, n on the row count only', () => {
    expect(enforceLimit('SELECT * FROM t LIMIT 50 OFFSET 0')).toBe('SELECT * FROM t LIMIT 50 OFFSET 0');
    expect(enforceLimit('SELECT * FROM t LIMIT 9999 OFFSET 10')).toBe('SELECT * FROM t LIMIT 500 OFFSET 10');
    expect(enforceLimit('SELECT * FROM t LIMIT 10, 9999')).toBe('SELECT * FROM t LIMIT 10, 500');
    expect(enforceLimit('SELECT * FROM t LIMIT 10, 20')).toBe('SELECT * FROM t LIMIT 10, 20');
  });
});

describe('LIMIT vs trailing comments and side-effect functions', () => {
  it('ignores LIMIT inside a trailing comment', () => {
    expect(enforceLimit('SELECT * FROM big -- LIMIT 1')).toBe('SELECT * FROM big -- LIMIT 1\nLIMIT 500');
    expect(enforceLimit('SELECT * FROM big # LIMIT 1')).toBe('SELECT * FROM big # LIMIT 1\nLIMIT 500');
  });

  it('keeps an explicit LIMIT followed by a comment valid', () => {
    expect(enforceLimit('SELECT * FROM t ORDER BY id DESC LIMIT 10 -- newest')).toBe('SELECT * FROM t ORDER BY id DESC LIMIT 10 -- newest');
    expect(enforceLimit('SELECT * FROM t LIMIT 9999 -- all')).toBe('SELECT * FROM t LIMIT 500');
  });

  it('does not treat # as a comment on PostgreSQL', () => {
    expect(enforceLimit("SELECT data #> '{a}' FROM t LIMIT 10", undefined, false)).toBe("SELECT data #> '{a}' FROM t LIMIT 10");
  });

  it('rejects session-scoped side-effect functions', () => {
    expect(isReadonlySQL("SELECT GET_LOCK('m', 0)")).toBe(false);
    expect(isReadonlySQL('SELECT pg_advisory_lock(1)')).toBe(false);
    expect(isReadonlySQL('SELECT pg_terminate_backend(pid) FROM pg_stat_activity')).toBe(false);
  });
});
