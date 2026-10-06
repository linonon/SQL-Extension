import type { ConnectionConfig } from './connection.js';
import type { RedisDbInfo, RedisRawKey, RedisScanResult } from './redis.js';

export interface IRedisDriver {
  readonly driverType: 'redis';

  connect(config: ConnectionConfig & { readonly password: string }): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  ping(): Promise<void>;
  listDatabases(): Promise<readonly RedisDbInfo[]>;

  // 以下操作都显式带库号 db, 在该库自己的 client 上执行, 不在共享连接上 SELECT

  // key 浏览, 绝对禁止 KEYS 命令. 精确 key 名 (无 glob 元字符) 直接查 TYPE + TTL;
  // 否则从 cursor 起循环 SCAN, 直到凑够 count 个 key, 或 cursor 回到 0, 或本次已扫约 2 万个
  scan(db: number, pattern: string, cursor: string, count: number): Promise<RedisScanResult>;

  // 按类型读取
  getString(db: number, key: string): Promise<string | null>;
  hashScan(db: number, key: string, cursor: string, count: number): Promise<{ readonly cursor: string; readonly fields: Record<string, string> }>;
  getList(db: number, key: string, start: number, stop: number): Promise<readonly string[]>;
  getSet(db: number, key: string, cursor: string, count: number): Promise<{ readonly cursor: string; readonly members: readonly string[] }>;
  getZSet(db: number, key: string, start: number, stop: number): Promise<readonly { readonly member: string; readonly score: number }[]>;

  // 基本写入
  setString(db: number, key: string, value: string, ttl?: number): Promise<void>;
  setHashField(db: number, key: string, field: string, value: string): Promise<void>;
  deleteHashField(db: number, key: string, field: string): Promise<void>;

  // list 操作
  listPush(db: number, key: string, value: string, position: 'head' | 'tail'): Promise<void>;
  listSet(db: number, key: string, index: number, value: string): Promise<void>;
  listRemove(db: number, key: string, index: number): Promise<void>;

  // set 操作
  setAdd(db: number, key: string, member: string): Promise<void>;
  setRemove(db: number, key: string, member: string): Promise<void>;

  // sorted set 操作
  zsetAdd(db: number, key: string, member: string, score: number): Promise<void>;
  zsetRemove(db: number, key: string, member: string): Promise<void>;

  // key 管理
  deleteKey(db: number, key: string): Promise<void>;
  // TYPE 原样返回 (含模块类型如 ReJSON-RL), key 不存在为 'none'
  getKeyType(db: number, key: string): Promise<string>;
  getTTL(db: number, key: string): Promise<number>;
  setTTL(db: number, key: string, ttl: number): Promise<void>;
  removeTTL(db: number, key: string): Promise<void>;
  getListLength(db: number, key: string): Promise<number>;
  getZSetLength(db: number, key: string): Promise<number>;

  // 导出导入: key 和值都按 Buffer 读写, 二进制安全
  scanAllKeys(db: number, pattern: string): Promise<Buffer[]>;
  // 不支持的类型 items 为空; key 在 SCAN 之后消失时 type 为 'none'
  readKeyRaw(db: number, key: Buffer): Promise<RedisRawKey>;
  countExistingKeys(db: number, keys: readonly Buffer[]): Promise<number>;
  // 同一个 MULTI 里先 DEL 再按 items 重建, ttl > 0 时 EXPIRE; 别的连接看不到写了一半的 key
  writeKeyRaw(db: number, key: Buffer, raw: RedisRawKey): Promise<void>;

  // CLI 与 MCP 的任意命令: 每次在用完即断的独立连接上跑, 带命令超时, 拒绝 SUBSCRIBE / MONITOR 类推送命令.
  // 任意命令可能 SELECT / MULTI / 阻塞, 不能落在按库缓存的 client 上. db 省略即连接配置的库
  executeCommandInDb(db: number | undefined, args: readonly string[]): Promise<unknown>;
}
