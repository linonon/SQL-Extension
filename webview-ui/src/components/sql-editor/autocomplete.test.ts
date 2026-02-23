import { describe, it, expect } from 'vitest';
import { getAutocompleteContext, getCompletionItems, type AutocompleteContext } from './autocomplete';

const testSchema: Record<string, string[]> = {
  users: ['id', 'name', 'email', 'age'],
  orders: ['id', 'user_id', 'total', 'created_at'],
  products: ['id', 'name', 'price'],
};

describe('getAutocompleteContext', () => {
  it('FROM 后应该触发 table 补全', () => {
    const ctx = getAutocompleteContext('SELECT * FROM u', 15);
    expect(ctx.triggerType).toBe('table');
    expect(ctx.prefix).toBe('u');
  });

  it('JOIN 后应该触发 table 补全', () => {
    const ctx = getAutocompleteContext('SELECT * FROM users JOIN o', 26);
    expect(ctx.triggerType).toBe('table');
    expect(ctx.prefix).toBe('o');
  });

  it('INTO 后应该触发 table 补全', () => {
    const ctx = getAutocompleteContext('INSERT INTO ', 12);
    expect(ctx.triggerType).toBe('table');
    expect(ctx.prefix).toBe('');
  });

  it('UPDATE 后应该触发 table 补全', () => {
    const ctx = getAutocompleteContext('UPDATE us', 9);
    expect(ctx.triggerType).toBe('table');
    expect(ctx.prefix).toBe('us');
  });

  it('tableName. 后应该触发 column 补全', () => {
    const ctx = getAutocompleteContext('SELECT users.na', 15);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.tableName).toBe('users');
    expect(ctx.prefix).toBe('na');
  });

  it('tableName. (无前缀) 应该触发 column 补全', () => {
    const ctx = getAutocompleteContext('SELECT users.', 13);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.tableName).toBe('users');
    expect(ctx.prefix).toBe('');
  });

  it('>= 2 字符标识符应该触发 keyword 补全', () => {
    const ctx = getAutocompleteContext('SEL', 3);
    expect(ctx.triggerType).toBe('keyword');
    expect(ctx.prefix).toBe('SEL');
  });

  it('< 2 字符不应该触发补全', () => {
    const ctx = getAutocompleteContext('S', 1);
    expect(ctx.triggerType).toBe(null);
  });

  it('字符串内不应该触发补全', () => {
    const ctx = getAutocompleteContext("WHERE name = 'SEL", 18);
    expect(ctx.triggerType).toBe(null);
  });

  it('单行注释内不应该触发补全', () => {
    const ctx = getAutocompleteContext('-- SELECT', 9);
    expect(ctx.triggerType).toBe(null);
  });

  it('多行注释内不应该触发补全', () => {
    const ctx = getAutocompleteContext('/* SELECT', 9);
    expect(ctx.triggerType).toBe(null);
  });

  it('空字符串不应该触发补全', () => {
    const ctx = getAutocompleteContext('', 0);
    expect(ctx.triggerType).toBe(null);
  });

  // clause column 补全
  it('SELECT | FROM table 应触发 column 补全', () => {
    const sql = 'SELECT  FROM account_asset';
    const ctx = getAutocompleteContext(sql, 7);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.prefix).toBe('');
    expect(ctx.tableName).toBe('account_asset');
  });

  it('SELECT id, | FROM table 应触发 column 补全', () => {
    const sql = 'SELECT id,  FROM account_asset';
    const ctx = getAutocompleteContext(sql, 11);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.prefix).toBe('');
    expect(ctx.tableName).toBe('account_asset');
  });

  it('SELECT id, na| FROM table 应触发 column 补全并有 prefix', () => {
    const sql = 'SELECT id, na FROM account_asset';
    const ctx = getAutocompleteContext(sql, 13);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.prefix).toBe('na');
    expect(ctx.tableName).toBe('account_asset');
  });

  it('WHERE | 应触发 column 补全', () => {
    const sql = 'SELECT * FROM account_asset WHERE ';
    const ctx = getAutocompleteContext(sql, sql.length);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.prefix).toBe('');
    expect(ctx.tableName).toBe('account_asset');
  });

  it('WHERE na| 应触发 column 补全并有 prefix', () => {
    const sql = 'SELECT * FROM account_asset WHERE na';
    const ctx = getAutocompleteContext(sql, sql.length);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.prefix).toBe('na');
    expect(ctx.tableName).toBe('account_asset');
  });

  it('ORDER BY | 应触发 column 补全', () => {
    const sql = 'SELECT * FROM account_asset ORDER BY ';
    const ctx = getAutocompleteContext(sql, sql.length);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.prefix).toBe('');
    expect(ctx.tableName).toBe('account_asset');
  });

  it('SELECT | 无 FROM 不应触发 column 补全', () => {
    const sql = 'SELECT ';
    const ctx = getAutocompleteContext(sql, sql.length);
    expect(ctx.triggerType).toBe(null);
  });

  it('反引号表名应触发 column 补全', () => {
    const sql = 'SELECT  FROM `account_asset`';
    const ctx = getAutocompleteContext(sql, 7);
    expect(ctx.triggerType).toBe('column');
    expect(ctx.prefix).toBe('');
    expect(ctx.tableName).toBe('account_asset');
  });
});

describe('getCompletionItems', () => {
  it('table 类型应该返回匹配的表名', () => {
    const ctx: AutocompleteContext = { triggerType: 'table', prefix: 'u' };
    const items = getCompletionItems(ctx, testSchema);
    expect(items).toEqual(['users']);
  });

  it('table 无前缀应该返回所有表名', () => {
    const ctx: AutocompleteContext = { triggerType: 'table', prefix: '' };
    const items = getCompletionItems(ctx, testSchema);
    expect(items).toEqual(['users', 'orders', 'products']);
  });

  it('column 类型应该返回匹配的列名', () => {
    const ctx: AutocompleteContext = { triggerType: 'column', prefix: 'na', tableName: 'users' };
    const items = getCompletionItems(ctx, testSchema);
    expect(items).toEqual(['name']);
  });

  it('column 无前缀应该返回该表所有列', () => {
    const ctx: AutocompleteContext = { triggerType: 'column', prefix: '', tableName: 'users' };
    const items = getCompletionItems(ctx, testSchema);
    expect(items).toEqual(['id', 'name', 'email', 'age']);
  });

  it('keyword 类型应该返回匹配的关键字', () => {
    const ctx: AutocompleteContext = { triggerType: 'keyword', prefix: 'SEL' };
    const items = getCompletionItems(ctx, testSchema);
    expect(items).toContain('SELECT');
  });

  it('null 类型应该返回空数组', () => {
    const ctx: AutocompleteContext = { triggerType: null, prefix: '' };
    const items = getCompletionItems(ctx, testSchema);
    expect(items).toEqual([]);
  });

  it('不存在的表名应该返回空数组', () => {
    const ctx: AutocompleteContext = { triggerType: 'column', prefix: '', tableName: 'nonexistent' };
    const items = getCompletionItems(ctx, testSchema);
    expect(items).toEqual([]);
  });
});
