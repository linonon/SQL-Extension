import { describe, it, expect } from 'vitest';
import { isWholeTableWrite, openTransactionWarning, splitSqlStatements, statementAtCaret } from './destructive-sql';

describe('isWholeTableWrite', () => {
  it('DROP / TRUNCATE 总是需要确认', () => {
    expect(isWholeTableWrite('DROP TABLE users', 'mysql')).toBe(true);
    expect(isWholeTableWrite('TRUNCATE TABLE users', 'mysql')).toBe(true);
    expect(isWholeTableWrite('  drop table users;', 'mysql')).toBe(true);
  });

  it('无 WHERE 的整表 DELETE/UPDATE 需要确认', () => {
    expect(isWholeTableWrite('DELETE FROM users', 'mysql')).toBe(true);
    expect(isWholeTableWrite('UPDATE users SET active = 1', 'mysql')).toBe(true);
  });

  it('反引号/双引号标识符的整表 DELETE 也能识别 (旧正则 \\w 漏掉)', () => {
    expect(isWholeTableWrite('delete from `users`', 'mysql')).toBe(true);
    expect(isWholeTableWrite('DELETE FROM "users"', 'mysql')).toBe(true);
  });

  it('注释前缀不能绕过', () => {
    expect(isWholeTableWrite('/* cleanup */ DELETE FROM users', 'mysql')).toBe(true);
    expect(isWholeTableWrite('-- danger\nUPDATE users SET x=1', 'mysql')).toBe(true);
  });

  it('带 WHERE 的 DELETE/UPDATE 不打扰', () => {
    expect(isWholeTableWrite('DELETE FROM users WHERE id = 1', 'mysql')).toBe(false);
    expect(isWholeTableWrite('UPDATE users SET active = 1 WHERE id = 1', 'mysql')).toBe(false);
  });

  it('字符串常量里的 WHERE 不算真 WHERE (整表 UPDATE 仍确认)', () => {
    expect(isWholeTableWrite("UPDATE users SET note = 'where to go'", 'mysql')).toBe(true);
  });

  it('WHERE 判定按方言词法: 反斜杠转义, # 注释, dollar quote, E 字符串里的 where 不算', () => {
    expect(isWholeTableWrite("UPDATE t SET note = 'it\\'s where'", 'mysql')).toBe(true);
    expect(isWholeTableWrite('DELETE FROM t # where', 'mysql')).toBe(true);
    expect(isWholeTableWrite('UPDATE t SET body = $$ where $$', 'postgresql')).toBe(true);
    expect(isWholeTableWrite("UPDATE t SET a = E'x\\' where'", 'postgresql')).toBe(true);
    // PG 普通字符串不认反斜杠: 'x\' 已结束, 后面是真 WHERE
    expect(isWholeTableWrite("UPDATE t SET a = 'x\\' WHERE id = 1", 'postgresql')).toBe(false);
  });

  it('ALTER TABLE 删列 / 约束 / 分区需要确认 (与 Edit Table 删列一致); 只改列属性的 DROP DEFAULT / NOT NULL 不打扰', () => {
    expect(isWholeTableWrite('ALTER TABLE t DROP COLUMN c', 'mysql')).toBe(true);
    expect(isWholeTableWrite('alter table `t` add column x int, drop `c`', 'mysql')).toBe(true);
    expect(isWholeTableWrite('ALTER TABLE t DROP PARTITION p0', 'mysql')).toBe(true);
    expect(isWholeTableWrite('ALTER TABLE t TRUNCATE PARTITION p0', 'mysql')).toBe(true);
    expect(isWholeTableWrite('ALTER TABLE IF EXISTS "t" DROP CONSTRAINT t_pk', 'postgresql')).toBe(true);
    expect(isWholeTableWrite('ALTER TABLE t ALTER COLUMN c DROP DEFAULT', 'mysql')).toBe(false);
    expect(isWholeTableWrite('ALTER TABLE t ALTER COLUMN c DROP NOT NULL', 'postgresql')).toBe(false);
    expect(isWholeTableWrite("ALTER TABLE t ADD COLUMN drop_flag INT COMMENT 'drop me'", 'mysql')).toBe(false);
  });

  it('SELECT 不需要确认', () => {
    expect(isWholeTableWrite('SELECT * FROM users', 'mysql')).toBe(false);
  });

  it('多语句: 任一条整表 DELETE/UPDATE/DROP 都需确认 (逐条判断, 不被别条的 WHERE 掩盖)', () => {
    // 第一条带 WHERE, 第二条整表 DELETE -> 仍需确认
    expect(isWholeTableWrite('UPDATE t SET x=1 WHERE id=1; DELETE FROM big_table', 'mysql')).toBe(true);
    // 前置无害语句 + DROP -> 需确认
    expect(isWholeTableWrite('SELECT 1; DROP TABLE t', 'mysql')).toBe(true);
    // 第一条整表 DELETE, 第二条带 WHERE -> 仍需确认
    expect(isWholeTableWrite('DELETE FROM a; DELETE FROM b WHERE id=1', 'mysql')).toBe(true);
  });

  it("PG 里藏在 'a\\' 之后的 DROP 也要确认; 函数体里的整表 DELETE 不算", () => {
    expect(isWholeTableWrite("SELECT 'a\\'; DROP TABLE t; --'", 'postgresql')).toBe(true);
    expect(isWholeTableWrite('CREATE FUNCTION f() RETURNS void AS $$ DELETE FROM t; $$ LANGUAGE sql', 'postgresql')).toBe(false);
  });

  it('多语句: 每条 DELETE/UPDATE 都带 WHERE 时不打扰', () => {
    expect(isWholeTableWrite('UPDATE t SET x=1 WHERE id=1; DELETE FROM b WHERE id=2', 'mysql')).toBe(false);
  });
});


describe('splitSqlStatements', () => {
  it('按分号切分并丢掉空段', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;', 'mysql')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('字符串内分号不切分, 且返回原文 (字符串内容保留)', () => {
    expect(splitSqlStatements("UPDATE t SET note = 'a;b';", 'mysql')).toEqual([
      "UPDATE t SET note = 'a;b'",
    ]);
    expect(splitSqlStatements(`SELECT "x;y", 'it\\'s;', \`a;b\` FROM t`, 'mysql')).toEqual([
      `SELECT "x;y", 'it\\'s;', \`a;b\` FROM t`,
    ]);
  });

  it('注释内分号不切分, 注释原样保留; 只剩注释的段丢掉', () => {
    expect(splitSqlStatements('SELECT 1 /* ; */ ; SELECT 2 -- a;b\n; -- tail', 'mysql')).toEqual(['SELECT 1 /* ; */', 'SELECT 2 -- a;b']);
  });

  it('全空白返回空数组', () => {
    expect(splitSqlStatements('   ;  ;', 'mysql')).toEqual([]);
  });

  it('MySQL 的 # 是行注释; PG 里 # 是运算符', () => {
    expect(splitSqlStatements('SELECT 1 # a;b\n; SELECT 2', 'mysql')).toEqual(['SELECT 1 # a;b', 'SELECT 2']);
    expect(splitSqlStatements('SELECT 1 # 2; SELECT 3', 'postgresql')).toEqual(['SELECT 1 # 2', 'SELECT 3']);
  });

  it('PG 按服务端的切法: dollar quote 是字符串, 反斜杠不转义, 反引号不是引号', () => {
    const fn = 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql';
    expect(splitSqlStatements(`${fn}; SELECT 'a\\'; SELECT \`;\``, 'postgresql')).toEqual([fn, "SELECT 'a\\'", 'SELECT `', '`']);
  });
});

describe('statementAtCaret', () => {
  const at = (marked: string) => statementAtCaret(marked.replace('|', ''), marked.indexOf('|'), 'mysql');

  it('光标在语句内 / 语句末尾 / ; 之前: 取这一条', () => {
    expect(at('SELECT 1;\nUPD|ATE t SET a = 1;\nSELECT 3')).toBe('UPDATE t SET a = 1');
    expect(at('SELECT 1;\nSELECT 2|')).toBe('SELECT 2');
    expect(at('SELECT 1|;\nSELECT 2')).toBe('SELECT 1');
  });

  it('光标紧贴 ; 之后或落在其后的空白 / 空行里: 取前一条', () => {
    expect(at('SELECT 1;|\nSELECT 2')).toBe('SELECT 1');
    expect(at('SELECT 1;|SELECT 2')).toBe('SELECT 1');
    expect(at('SELECT 1;  |\n\nSELECT 2')).toBe('SELECT 1');
    expect(at('SELECT 1;\n|\nSELECT 2')).toBe('SELECT 1');
    expect(at('SELECT 1;\nSELECT 2;\n|')).toBe('SELECT 2');
  });

  it('; 之后的注释里 (下一条的代码之前): 取前一条', () => {
    expect(at('SELECT 1; -- c|\nUPDATE t SET a = 1 WHERE id = 2;')).toBe('SELECT 1');
    expect(at('SELECT 1; /* x */|\nDELETE FROM t WHERE id = 3;')).toBe('SELECT 1');
    expect(at('SELECT 1;\n-- next|\nDELETE FROM t WHERE id = 3;')).toBe('SELECT 1');
    // 光标到了下一条的第一个代码字符: 取下一条 (带着它前导的注释)
    expect(at('SELECT 1; /* x */\n|DELETE FROM t WHERE id = 3;')).toBe('/* x */\nDELETE FROM t WHERE id = 3');
  });

  it('光标在下一条开头: 取下一条; 在第一条之前的空白里: 取第一条', () => {
    expect(at('SELECT 1;\n|SELECT 2')).toBe('SELECT 2');
    expect(at('|\n  SELECT 1; SELECT 2')).toBe('SELECT 1');
  });

  it('引号 / 反引号 / 注释里的 ; 不切分', () => {
    expect(at("SELECT 'a;b', `c;d` /* ; */ FROM t -- ;\nWHERE x|=1; SELECT 2")).toBe("SELECT 'a;b', `c;d` /* ; */ FROM t -- ;\nWHERE x=1");
  });

  it('PG: 光标在函数体里取整个 CREATE FUNCTION', () => {
    const fn = 'CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  DELETE FROM t WHERE id = 1;\nEND $$ LANGUAGE plpgsql';
    const sql = `SELECT 1;\n${fn};\nSELECT 2`;
    const caret = sql.indexOf('DELETE');
    expect(statementAtCaret(sql, caret, 'postgresql')).toBe(fn);
  });

  it('空文本 / 只有空白和注释: 没有语句', () => {
    expect(at('|')).toBeUndefined();
    expect(at('  ;\n-- note\n|')).toBeUndefined();
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
