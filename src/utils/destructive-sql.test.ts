import { describe, it, expect } from 'vitest';
import { isWholeTableWrite } from './destructive-sql';

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
});
