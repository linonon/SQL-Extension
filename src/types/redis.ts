export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'unknown';

export interface RedisKeyInfo {
  readonly key: string;
  readonly type: RedisKeyType;
  readonly ttl: number; // -1 = no expiry, -2 = key not found
}

export interface RedisScanResult {
  readonly cursor: string;
  readonly keys: readonly RedisKeyInfo[];
}

export interface RedisDbInfo {
  readonly index: number;
  readonly keyCount: number;
}

export interface RedisServerInfo {
  readonly version: string;
  readonly mode: string;
  readonly connectedClients: number;
  readonly usedMemory: string;
  readonly totalKeys: number;
  readonly raw: string;
}

export type RedisValue =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'hash'; readonly value: Record<string, string>; readonly cursor: string }
  | { readonly type: 'list'; readonly value: readonly string[]; readonly total: number }
  | { readonly type: 'set'; readonly value: readonly string[]; readonly cursor: string }
  | { readonly type: 'zset'; readonly value: readonly { readonly member: string; readonly score: number }[]; readonly total: number };

export interface RedisExportKeyEntry {
  readonly key: string;
  readonly type: RedisKeyType;
  readonly ttl: number;
  readonly value:
    | string
    | Record<string, string>
    | readonly string[]
    | readonly { readonly member: string; readonly score: number }[];
}

export interface RedisExportData {
  readonly version: 1;
  readonly exportedAt: string;
  readonly database: number;
  readonly keys: readonly RedisExportKeyEntry[];
}
