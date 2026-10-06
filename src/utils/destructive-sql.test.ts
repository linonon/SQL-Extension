import { describe, it, expect } from 'vitest';
import { isWholeTableWrite, openTransactionWarning, splitSqlStatements } from './destructive-sql';

describe('isWholeTableWrite', () => {
  it('DROP / TRUNCATE 总是需要确认', () => {
    expect(isWholeTableWrite('DROP TABLE users')).toBe(true);
    expect(isWholeTableWrite('TRUNCATE TABLE users')).toBe(true);
    expect(isWholeTableWrite('  drop table users;')).toBe(true);
  });

  it('无 WHERE 的整表 DELETE/UPDATE 需要确认', () => {
    expect(isWholeTableWrite('DELETE FROM users')).toBe(true);
    expect(isWholeTableWrite('UPDATE users SET active = 1')).toBe(true);
  });

  it('反引号/双引号标识符的整表 DELETE 也能识别 (旧正则 \\w 漏掉)', () => {
    expect(isWholeTableWrite('delete from `users`')).toBe(true);
    expect(isWholeTableWrite('DELETE FROM "users"')).toBe(true);
  });

  it('注释前缀不能绕过', () => {
    expect(isWholeTableWrite('/* cleanup */ DELETE FROM users')).toBe(true);
    expect(isWholeTableWrite('-- danger\nUPDATE users SET x=1')).toBe(true);
  });

  it('带 WHERE 的 DELETE/UPDATE 不打扰', () => {
    expect(isWholeTableWrite('DELETE FROM users WHERE id = 1')).toBe(false);
    expect(isWholeTableWrite('UPDATE users SET active = 1 WHERE id = 1')).toBe(false);
  });

  it('字符串常量里的 WHERE 不算真 WHERE (整表 UPDATE 仍确认)', () => {
    expect(isWholeTableWrite("UPDATE users SET note = 'where to go'")).toBe(true);
  });

  it('SELECT 不需要确认', () => {
    expect(isWholeTableWrite('SELECT * FROM users')).toBe(false);
  });

  it('多语句: 任一条整表 DELETE/UPDATE/DROP 都需确认 (逐条判断, 不被别条的 WHERE 掩盖)', () => {
    // 第一条带 WHERE, 第二条整表 DELETE -> 仍需确认
    expect(isWholeTableWrite('UPDATE t SET x=1 WHERE id=1; DELETE FROM big_table')).toBe(true);
    // 前置无害语句 + DROP -> 需确认
    expect(isWholeTableWrite('SELECT 1; DROP TABLE t')).toBe(true);
    // 第一条整表 DELETE, 第二条带 WHERE -> 仍需确认
    expect(isWholeTableWrite('DELETE FROM a; DELETE FROM b WHERE id=1')).toBe(true);
  });

  it('多语句: 每条 DELETE/UPDATE 都带 WHERE 时不打扰', () => {
    expect(isWholeTableWrite('UPDATE t SET x=1 WHERE id=1; DELETE FROM b WHERE id=2')).toBe(false);
  });
});


describe('splitSqlStatements', () => {
  it('按分号切分并丢掉空段', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('字符串内分号不切分, 且返回原文 (字符串内容保留)', () => {
    expect(splitSqlStatements("UPDATE t SET note = 'a;b';")).toEqual([
      "UPDATE t SET note = 'a;b'",
    ]);
    expect(splitSqlStatements(`SELECT "x;y", 'it\\'s;', \`a;b\` FROM t`)).toEqual([
      `SELECT "x;y", 'it\\'s;', \`a;b\` FROM t`,
    ]);
  });

  it('注释内分号不切分, 注释原样保留; 只剩注释的段丢掉', () => {
    expect(splitSqlStatements('SELECT 1 /* ; */ ; SELECT 2 -- a;b\n; -- tail')).toEqual(['SELECT 1 /* ; */', 'SELECT 2 -- a;b']);
  });

  it('全空白返回空数组', () => {
    expect(splitSqlStatements('   ;  ;')).toEqual([]);
  });
});

describe('openTransactionWarning', () => {
  it('BEGIN / START TRANSACTION 之后没有 COMMIT / ROLLBACK / END 才提示', () => {
    expect(openTransactionWarning(['BEGIN', 'UPDATE t SET a = 1'])).toMatch(/rolled back/);
    expect(openTransactionWarning(['-- tx\nstart transaction', 'DELETE FROM t WHERE id = 1'])).toMatch(/rolled back/);
    expect(openTransactionWarning(['BEGIN', 'UPDATE t SET a = 1', 'COMMIT'])).toBeUndefined();
    expect(openTransactionWarning(['BEGIN', 'ROLLBACK'])).toBeUndefined();
    expect(openTransactionWarning(['BEGIN', 'END'])).toBeUndefined();
    expect(openTransactionWarning(['UPDATE t SET note = \'BEGIN\' WHERE id = 1'])).toBeUndefined();
  });

  it('autocommit 关掉后执行过语句, 到结束仍没提交才提示', () => {
    expect(openTransactionWarning(['SET autocommit = 0', 'UPDATE t SET x = 1 WHERE id = 1'])).toMatch(/rolled back/);
    expect(openTransactionWarning(['SET @@session.autocommit=OFF', 'UPDATE t SET x = 1 WHERE id = 1', 'COMMIT'])).toBeUndefined();
    // COMMIT 之后的语句又隐式开了新事务
    expect(openTransactionWarning(['SET autocommit = 0', 'UPDATE t SET x = 1', 'COMMIT', 'DELETE FROM t WHERE id = 2'])).toMatch(/rolled back/);
    // 置回 1 会提交当前事务
    expect(openTransactionWarning(['SET SESSION autocommit = 0', 'UPDATE t SET x = 1', 'SET autocommit = 1'])).toBeUndefined();
    expect(openTransactionWarning(['SET autocommit = 0'])).toBeUndefined();
  });

  it('ROLLBACK TO SAVEPOINT 不结束事务', () => {
    expect(openTransactionWarning(['BEGIN', 'SAVEPOINT s', 'ROLLBACK TO SAVEPOINT s'])).toMatch(/rolled back/);
  });
});
