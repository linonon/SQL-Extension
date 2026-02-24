import { describe, it, expect } from 'vitest';
import { buildKeyTree, fuzzyMatch, filterKeysFuzzy } from './redis-keys';
import type { RedisKeyInfo } from '../types/redis';

const mkKey = (key: string, type = 'string' as const, ttl = -1): RedisKeyInfo => ({ key, type, ttl });

describe('buildKeyTree', () => {
  it('空数组返回空树', () => {
    const tree = buildKeyTree([]);
    expect(tree.children).toHaveLength(0);
    expect(tree.leafKeys).toHaveLength(0);
  });

  it('无冒号 key 归入顶层 leafKeys', () => {
    const keys = [mkKey('foo'), mkKey('bar')];
    const tree = buildKeyTree(keys);
    expect(tree.children).toHaveLength(0);
    expect(tree.leafKeys).toHaveLength(2);
    expect(tree.leafKeys.map((k) => k.key)).toContain('foo');
    expect(tree.leafKeys.map((k) => k.key)).toContain('bar');
  });

  it('一级分组', () => {
    const keys = [mkKey('user:1'), mkKey('user:2'), mkKey('session:a')];
    const tree = buildKeyTree(keys);
    expect(tree.children).toHaveLength(2);
    const userNode = tree.children.find((c) => c.segment === 'user');
    expect(userNode).toBeDefined();
    expect(userNode!.totalCount).toBe(2);
    expect(userNode!.leafKeys).toHaveLength(2);
    const sessionNode = tree.children.find((c) => c.segment === 'session');
    expect(sessionNode).toBeDefined();
    expect(sessionNode!.totalCount).toBe(1);
  });

  it('单 key 前缀也成组 (无 >= 2 限制)', () => {
    const keys = [mkKey('user:1'), mkKey('session:a')];
    const tree = buildKeyTree(keys);
    // 两个都应成组, 不再限制 >= 2
    expect(tree.children).toHaveLength(2);
    expect(tree.leafKeys).toHaveLength(0);
  });

  it('多级嵌套: game:1001:round_id', () => {
    const keys = [mkKey('game:1001:round_id'), mkKey('game:1001:score'), mkKey('game:1002:round_id')];
    const tree = buildKeyTree(keys);
    expect(tree.children).toHaveLength(1);
    const gameNode = tree.children[0];
    expect(gameNode.segment).toBe('game');
    expect(gameNode.children).toHaveLength(2);
    const node1001 = gameNode.children.find((c) => c.segment === '1001');
    expect(node1001).toBeDefined();
    expect(node1001!.leafKeys).toHaveLength(2);
    expect(node1001!.children).toHaveLength(0);
  });

  it('混合: 有冒号和无冒号 key 共存', () => {
    const keys = [mkKey('_kombu.binding'), mkKey('lucky:black:key'), mkKey('lucky:black_set')];
    const tree = buildKeyTree(keys);
    // _kombu.binding 无冒号, 顶层 leaf
    expect(tree.leafKeys.map((k) => k.key)).toContain('_kombu.binding');
    // lucky 成组
    const luckyNode = tree.children.find((c) => c.segment === 'lucky');
    expect(luckyNode).toBeDefined();
    // lucky:black 子分组
    const blackNode = luckyNode!.children.find((c) => c.segment === 'black');
    expect(blackNode).toBeDefined();
    // lucky:black_set 是 lucky 层的 leaf
    expect(luckyNode!.leafKeys.map((k) => k.key)).toContain('lucky:black_set');
  });

  it('顶层子节点按字母序排列', () => {
    const keys = [mkKey('z:1'), mkKey('a:1')];
    const tree = buildKeyTree(keys);
    expect(tree.children[0].segment).toBe('a');
    expect(tree.children[1].segment).toBe('z');
  });

  it('totalCount 等于该前缀下所有 key 数量', () => {
    const keys = [mkKey('a:b:1'), mkKey('a:b:2'), mkKey('a:c:1')];
    const tree = buildKeyTree(keys);
    const aNode = tree.children[0];
    expect(aNode.segment).toBe('a');
    expect(aNode.totalCount).toBe(3);
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
