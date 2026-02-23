import type { RedisKeyInfo } from '../types/redis';

export interface KeyGroup {
  readonly prefix: string;
  readonly displayName: string;
  readonly keys: readonly RedisKeyInfo[];
}

/**
 * 按第一个 `:` 前缀做一级分组.
 * >= 2 个同前缀 key 才成组, 否则顶层展示.
 */
export function groupKeys(keys: readonly RedisKeyInfo[]): readonly KeyGroup[] {
  const buckets = new Map<string, RedisKeyInfo[]>();

  for (const k of keys) {
    const colonIdx = k.key.indexOf(':');
    const prefix = colonIdx === -1 ? '' : k.key.slice(0, colonIdx + 1);
    const bucket = buckets.get(prefix);
    if (bucket) {
      bucket.push(k);
    } else {
      buckets.set(prefix, [k]);
    }
  }

  const groups: KeyGroup[] = [];
  const topLevel: RedisKeyInfo[] = [];

  const sortedPrefixes = [...buckets.keys()].sort();
  for (const prefix of sortedPrefixes) {
    const bucket = buckets.get(prefix)!;
    if (prefix === '' || bucket.length < 2) {
      topLevel.push(...bucket);
    } else {
      groups.push({ prefix, displayName: prefix, keys: bucket });
    }
  }

  const result: KeyGroup[] = [];
  if (topLevel.length > 0) {
    result.push({ prefix: '', displayName: '', keys: topLevel });
  }
  result.push(...groups);
  return result;
}

/**
 * Subsequence matching (fzf 风格).
 * 返回匹配字符索引数组, 不匹配返回 null.
 */
export function fuzzyMatch(query: string, target: string): readonly number[] | null {
  if (query === '') { return []; }
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  return qi === q.length ? indices : null;
}

/**
 * 空 query 返回全部, 否则 fuzzy 过滤.
 */
export function filterKeysFuzzy(
  keys: readonly RedisKeyInfo[],
  query: string
): readonly RedisKeyInfo[] {
  const trimmed = query.trim();
  if (trimmed === '') { return keys; }
  return keys.filter((k) => fuzzyMatch(trimmed, k.key) !== null);
}
