export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'unknown';

export interface RedisKeyInfo {
  readonly key: string;
  readonly type: RedisKeyType;
  readonly ttl: number;
}

export type RedisValue =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'hash'; readonly value: Record<string, string>; readonly cursor: string }
  | { readonly type: 'list'; readonly value: readonly string[]; readonly total: number }
  | { readonly type: 'set'; readonly value: readonly string[]; readonly cursor: string }
  | { readonly type: 'zset'; readonly value: readonly { readonly member: string; readonly score: number }[]; readonly total: number };
