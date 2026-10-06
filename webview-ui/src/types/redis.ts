export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'unknown';

export interface RedisKeyInfo {
  readonly key: string;
  readonly type: RedisKeyType;
  readonly ttl: number;
}

// list / zset 的 start 是 value[0] 在 Redis 里的下标, value[i] 即 index start + i.
// unsupported: 浏览器不能编辑的类型 (stream, 模块类型如 ReJSON-RL, key 已不存在为 'none'), typeName 为 TYPE 原样返回
export type RedisValue =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'hash'; readonly value: Record<string, string>; readonly cursor: string }
  | { readonly type: 'list'; readonly value: readonly string[]; readonly total: number; readonly start: number }
  | { readonly type: 'set'; readonly value: readonly string[]; readonly cursor: string }
  | { readonly type: 'zset'; readonly value: readonly { readonly member: string; readonly score: number }[]; readonly total: number; readonly start: number }
  | { readonly type: 'unsupported'; readonly typeName: string };
