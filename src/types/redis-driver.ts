import type { ConnectionConfig } from './connection.js';
import type { RedisDbInfo, RedisKeyType, RedisScanResult } from './redis.js';

export interface IRedisDriver {
  readonly driverType: 'redis';

  connect(config: ConnectionConfig & { readonly password: string }): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  ping(): Promise<void>;

  // database 操作
  selectDatabase(db: number): Promise<void>;
  listDatabases(): Promise<readonly RedisDbInfo[]>;

  // key 扫描 - 绝对禁止 KEYS 命令
  scan(pattern: string, cursor: string, count: number): Promise<RedisScanResult>;

  // 按类型读取
  getString(key: string): Promise<string | null>;
  getHash(key: string): Promise<Record<string, string>>;
  hashScan(key: string, cursor: string, count: number): Promise<{ readonly cursor: string; readonly fields: Record<string, string> }>;
  getList(key: string, start: number, stop: number): Promise<readonly string[]>;
  getSet(key: string, cursor: string, count: number): Promise<{ readonly cursor: string; readonly members: readonly string[] }>;
  getZSet(key: string, start: number, stop: number): Promise<readonly { readonly member: string; readonly score: number }[]>;

  // 基本写入
  setString(key: string, value: string, ttl?: number): Promise<void>;
  setHashField(key: string, field: string, value: string): Promise<void>;
  deleteHashField(key: string, field: string): Promise<void>;

  // list 操作
  listPush(key: string, value: string, position: 'head' | 'tail'): Promise<void>;
  listSet(key: string, index: number, value: string): Promise<void>;
  listRemove(key: string, index: number): Promise<void>;

  // set 操作
  setAdd(key: string, member: string): Promise<void>;
  setRemove(key: string, member: string): Promise<void>;

  // sorted set 操作
  zsetAdd(key: string, member: string, score: number): Promise<void>;
  zsetRemove(key: string, member: string): Promise<void>;

  // key 管理
  deleteKey(key: string): Promise<void>;
  getKeyType(key: string): Promise<RedisKeyType>;
  getTTL(key: string): Promise<number>;
  setTTL(key: string, ttl: number): Promise<void>;
  removeTTL(key: string): Promise<void>;
  getListLength(key: string): Promise<number>;
  getZSetLength(key: string): Promise<number>;

  // CLI
  executeCommand(args: readonly string[]): Promise<unknown>;
}
