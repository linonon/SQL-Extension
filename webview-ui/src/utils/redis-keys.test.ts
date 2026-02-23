import { describe, it, expect } from 'vitest';
import { groupKeys, fuzzyMatch, filterKeysFuzzy } from './redis-keys';
import type { RedisKeyInfo } from '../types/redis';

const mkKey = (key: string, type = 'string' as const, ttl = -1): RedisKeyInfo => ({ key, type, ttl });

describe('groupKeys', () => {
  it('空数组返回空', () => {
    expect(groupKeys([])).toEqual([]);
  });

  it('无前缀 key 归入顶层组', () => {
    const keys = [mkKey('foo'), mkKey('bar')];
    const groups = groupKeys(keys);
    expect(groups).toHaveLength(1);
    expect(groups[0].prefix).toBe('');
    expect(groups[0].keys).toHaveLength(2);
  });

  it('多个同前缀 key 成组', () => {
    const keys = [mkKey('user:1'), mkKey('user:2'), mkKey('session:a'), mkKey('session:b')];
    const groups = groupKeys(keys);
    expect(groups).toHaveLength(2);
    expect(groups[0].prefix).toBe('session:');
    expect(groups[0].keys).toHaveLength(2);
    expect(groups[1].prefix).toBe('user:');
    expect(groups[1].keys).toHaveLength(2);
  });

  it('单 key 前缀不成组, 归入顶层', () => {
    const keys = [mkKey('user:1'), mkKey('session:a'), mkKey('session:b')];
    const groups = groupKeys(keys);
    // user:1 是唯一的 user: 前缀, 归入顶层
    const topLevel = groups.find((g) => g.prefix === '');
    expect(topLevel).toBeDefined();
    expect(topLevel!.keys.map((k) => k.key)).toContain('user:1');
    // session: 有 2 个, 成组
    const sessionGroup = groups.find((g) => g.prefix === 'session:');
    expect(sessionGroup).toBeDefined();
    expect(sessionGroup!.keys).toHaveLength(2);
  });

  it('混合: 有前缀和无前缀 key', () => {
    const keys = [mkKey('foo'), mkKey('user:1'), mkKey('user:2')];
    const groups = groupKeys(keys);
    const topLevel = groups.find((g) => g.prefix === '');
    expect(topLevel!.keys.map((k) => k.key)).toContain('foo');
    const userGroup = groups.find((g) => g.prefix === 'user:');
    expect(userGroup!.keys).toHaveLength(2);
  });

  it('组按 prefix 字母序排列', () => {
    const keys = [mkKey('z:1'), mkKey('z:2'), mkKey('a:1'), mkKey('a:2')];
    const groups = groupKeys(keys);
    expect(groups[0].prefix).toBe('a:');
    expect(groups[1].prefix).toBe('z:');
  });
});

describe('fuzzyMatch', () => {
  it('空 query 匹配任意, 返回空索引数组', () => {
    expect(fuzzyMatch('', 'anything')).toEqual([]);
  });

  it('精确匹配', () => {
    const result = fuzzyMatch('abc', 'abc');
    expect(result).toEqual([0, 1, 2]);
  });

  it('subsequence 匹配', () => {
    const result = fuzzyMatch('uprof', 'user:profile:abc');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(5);
  });

  it('case-insensitive', () => {
    expect(fuzzyMatch('ABC', 'abcdef')).toEqual([0, 1, 2]);
  });

  it('不匹配返回 null', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull();
  });

  it('部分匹配不够返回 null', () => {
    expect(fuzzyMatch('abcd', 'abc')).toBeNull();
  });
});

describe('filterKeysFuzzy', () => {
  const keys = [mkKey('user:1'), mkKey('user:profile'), mkKey('session:abc')];

  it('空 query 返回全部', () => {
    expect(filterKeysFuzzy(keys, '')).toEqual(keys);
    expect(filterKeysFuzzy(keys, '  ')).toEqual(keys);
  });

  it('正常过滤', () => {
    const result = filterKeysFuzzy(keys, 'user');
    expect(result).toHaveLength(2);
    expect(result.every((k) => k.key.includes('user'))).toBe(true);
  });

  it('fuzzy 过滤', () => {
    const result = filterKeysFuzzy(keys, 'uprof');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('user:profile');
  });
});
