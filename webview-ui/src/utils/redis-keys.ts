import type { RedisKeyInfo } from '../types/redis';

export interface KeyTreeNode {
  readonly segment: string;
  readonly fullPrefix: string;
  readonly children: readonly KeyTreeNode[];
  readonly leafKeys: readonly RedisKeyInfo[];
  readonly totalCount: number;
}

export interface KeyTree {
  readonly children: readonly KeyTreeNode[];
  readonly leafKeys: readonly RedisKeyInfo[];
}

/**
 * 递归构建 key 分组树, 对标 ARDM 无限层级.
 * prefix 为当前层级的完整前缀字符串 (含末尾 ":").
 */
export function buildKeyTree(keys: readonly RedisKeyInfo[], prefix: string = ''): KeyTree {
  const childMap = new Map<string, RedisKeyInfo[]>();
  const leafKeys: RedisKeyInfo[] = [];

  for (const k of keys) {
    const remaining = k.key.slice(prefix.length);
    const colonIdx = remaining.indexOf(':');
    if (colonIdx === -1) {
      leafKeys.push(k);
    } else {
      const segment = remaining.slice(0, colonIdx);
      const childPrefix = prefix + segment + ':';
      const arr = childMap.get(childPrefix) ?? [];
      arr.push(k);
      childMap.set(childPrefix, arr);
    }
  }

  const children: KeyTreeNode[] = [...childMap.entries()]
    .map(([childPrefix, childKeys]) => {
      const segment = childPrefix.slice(prefix.length, -1);
      const sub = buildKeyTree(childKeys, childPrefix);
      return {
        segment,
        fullPrefix: childPrefix,
        children: sub.children,
        leafKeys: sub.leafKeys,
        totalCount: childKeys.length,
      };
    })
    .sort((a, b) => a.segment.localeCompare(b.segment));

  return {
    children,
    leafKeys: leafKeys.sort((a, b) => a.key.localeCompare(b.key)),
  };
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
