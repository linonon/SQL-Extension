export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'unknown';

export interface RedisKeyInfo {
  readonly key: string;
  readonly type: RedisKeyType;
  readonly ttl: number; // -1 = no expiry, -2 = key not found
}

export interface RedisScanResult {
  readonly cursor: string;
  readonly keys: readonly RedisKeyInfo[];
  readonly scanned: number; // 本次请求扫过的 key 数估值 (SCAN 轮数 x COUNT)
}

export interface RedisDbInfo {
  readonly index: number;
  readonly keyCount: number;
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

// 导出导入在 driver 层的原始形态, 全部是 Buffer, 不做 utf8 解码.
// items: string 为 [value]; hash 为 [field, value, ...]; list / set 为成员; zset 为 [member, score, ...]
export interface RedisRawKey {
  readonly type: string; // TYPE 原样返回; 'none' = key 已不存在
  readonly ttl: number; // 秒, -1 = 不过期
  readonly items: readonly Buffer[];
}

// 导出文件里的字节串: 合法 utf8 直接存字符串, 否则存 base64 并显式标记
export type RedisExportBytes = string | { readonly encoding: 'base64'; readonly data: string };

export type RedisExportType = 'string' | 'hash' | 'list' | 'set' | 'zset';

export interface RedisExportKeyEntry {
  readonly key: RedisExportBytes;
  readonly type: RedisExportType;
  readonly ttl: number;
  readonly value:
    | RedisExportBytes
    | readonly { readonly field: RedisExportBytes; readonly value: RedisExportBytes }[]
    | readonly RedisExportBytes[]
    // score 是有限数时存数字, inf / -inf 存 Redis 原样的字符串
    | readonly { readonly member: RedisExportBytes; readonly score: number | string }[];
}

// version 1 的 hash 是 { field: value } 对象且没有 base64 标记, 导入仍兼容
export interface RedisExportData {
  readonly version: 2;
  readonly exportedAt: string;
  readonly database: number;
  readonly keys: readonly RedisExportKeyEntry[];
}
