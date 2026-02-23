import { describe, it, expect } from 'vitest';
import { tokenize, type Token } from './sql-tokenizer';

function types(sql: string): string[] {
  return tokenize(sql).map((t) => t.type);
}

function values(sql: string): string[] {
  return tokenize(sql).map((t) => t.value);
}

describe('tokenize', () => {
  it('应该识别 SQL 关键字 (大小写不敏感)', () => {
    const tokens = tokenize('SELECT from WHERE');
    const keywords = tokens.filter((t) => t.type === 'keyword');
    expect(keywords.map((t) => t.value)).toEqual(['SELECT', 'from', 'WHERE']);
  });

  it('应该识别标识符', () => {
    const tokens = tokenize('SELECT user_name FROM users');
    const idents = tokens.filter((t) => t.type === 'identifier');
    expect(idents.map((t) => t.value)).toEqual(['user_name', 'users']);
  });

  it('应该识别单引号字符串', () => {
    const tokens = tokenize("WHERE name = 'Alice'");
    const strings = tokens.filter((t) => t.type === 'string');
    expect(strings.map((t) => t.value)).toEqual(["'Alice'"]);
  });

  it('应该识别双引号字符串', () => {
    const tokens = tokenize('WHERE name = "Bob"');
    const strings = tokens.filter((t) => t.type === 'string');
    expect(strings.map((t) => t.value)).toEqual(['"Bob"']);
  });

  it('应该处理字符串内的转义', () => {
    const tokens = tokenize("'it\\'s ok'");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('string');
    expect(tokens[0].value).toBe("'it\\'s ok'");
  });

  it('应该识别反引号标识符 (MySQL)', () => {
    const tokens = tokenize('SELECT `table` FROM `db`.`users`');
    const idents = tokens.filter((t) => t.type === 'identifier');
    expect(idents.map((t) => t.value)).toContain('`table`');
  });

  it('应该识别整数和小数', () => {
    const tokens = tokenize('WHERE id = 42 AND price > 3.14');
    const nums = tokens.filter((t) => t.type === 'number');
    expect(nums.map((t) => t.value)).toEqual(['42', '3.14']);
  });

  it('应该识别单行注释', () => {
    const tokens = tokenize('SELECT 1 -- this is comment');
    const comments = tokens.filter((t) => t.type === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].value).toBe('-- this is comment');
  });

  it('应该识别多行注释', () => {
    const tokens = tokenize('SELECT /* multi\nline */ 1');
    const comments = tokens.filter((t) => t.type === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].value).toBe('/* multi\nline */');
  });

  it('应该识别两字符 operator', () => {
    const tokens = tokenize('a <> b AND c >= d AND e != f');
    const ops = tokens.filter((t) => t.type === 'operator');
    expect(ops.map((t) => t.value)).toContain('<>');
    expect(ops.map((t) => t.value)).toContain('>=');
    expect(ops.map((t) => t.value)).toContain('!=');
  });

  it('应该识别单字符 operator', () => {
    const tokens = tokenize('a + b - c * d / e');
    const ops = tokens.filter((t) => t.type === 'operator');
    expect(ops.map((t) => t.value)).toEqual(['+', '-', '*', '/']);
  });

  it('应该识别 punctuation', () => {
    const tokens = tokenize('(a, b);');
    const puncs = tokens.filter((t) => t.type === 'punctuation');
    expect(puncs.map((t) => t.value)).toEqual(['(', ',', ')' , ';']);
  });

  it('应该正确记录 token start 位置', () => {
    const tokens = tokenize('SELECT id');
    expect(tokens[0].start).toBe(0);                    // SELECT
    expect(tokens[1].start).toBe(6);                    // whitespace
    expect(tokens[2].start).toBe(7);                    // id
  });

  it('应该处理空字符串', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('应该处理完整 SQL 语句', () => {
    const sql = "SELECT u.id, u.name FROM users u WHERE u.age >= 18 AND u.name LIKE '%test%';";
    const tokens = tokenize(sql);
    // 确保所有字符都被覆盖
    const reconstructed = tokens.map((t) => t.value).join('');
    expect(reconstructed).toBe(sql);
  });

  it('应该将 whitespace 识别为独立 token', () => {
    const tokens = tokenize('SELECT  id');
    const ws = tokens.filter((t) => t.type === 'whitespace');
    expect(ws).toHaveLength(1);
    expect(ws[0].value).toBe('  ');
  });

  it('应该处理未闭合的字符串', () => {
    const tokens = tokenize("SELECT 'unclosed");
    const strings = tokens.filter((t) => t.type === 'string');
    expect(strings).toHaveLength(1);
    expect(strings[0].value).toBe("'unclosed");
  });

  it('应该处理未闭合的多行注释', () => {
    const tokens = tokenize('SELECT /* unclosed');
    const comments = tokens.filter((t) => t.type === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].value).toBe('/* unclosed');
  });
});
