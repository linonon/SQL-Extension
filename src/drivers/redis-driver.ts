import Redis from 'ioredis';
import type { ConnectionConfig } from '../types/connection.js';
import type { IRedisDriver } from '../types/redis-driver.js';
import type { RedisDbInfo, RedisKeyInfo, RedisKeyType, RedisScanResult } from '../types/redis.js';

function parseKeyType(raw: string): RedisKeyType {
  const normalized = raw.toLowerCase();
  if (normalized === 'string' || normalized === 'hash' || normalized === 'list'
    || normalized === 'set' || normalized === 'zset' || normalized === 'stream') {
    return normalized;
  }
  return 'unknown';
}

export class RedisDriver implements IRedisDriver {
  readonly driverType = 'redis' as const;
  private client: Redis | null = null;

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    const client = new Redis({
      host: config.host,
      port: config.port,
      username: config.username || undefined,
      password: config.password || undefined,
      db: config.database ? Number(config.database) : 0,
      connectTimeout: 5000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await client.connect();
    // 验证连接
    await client.ping();
    this.client = client;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.status === 'ready';
  }

  async ping(): Promise<void> {
    if (!this.client || this.client.status !== 'ready') {
      throw new Error('Redis client is not connected');
    }
    await this.client.ping();
  }

  async selectDatabase(db: number): Promise<void> {
    this.assertConnected();
    await this.client!.select(db);
  }

  async listDatabases(): Promise<readonly RedisDbInfo[]> {
    this.assertConnected();
    const databases: RedisDbInfo[] = [];

    try {
      const info = await this.client!.info('keyspace');
      // 解析 INFO keyspace 输出: "db0:keys=1234,expires=5,avg_ttl=0"
      for (let i = 0; i < 16; i++) {
        const match = info.match(new RegExp(`db${i}:keys=(\\d+)`));
        databases.push({
          index: i,
          keyCount: match ? Number(match[1]) : 0,
        });
      }
    } catch {
      // ACL 限制无 INFO 权限时, 返回 16 个 db, keyCount 未知用 -1 表示
      for (let i = 0; i < 16; i++) {
        databases.push({ index: i, keyCount: -1 });
      }
    }

    return databases;
  }

  async scan(pattern: string, cursor: string, count: number): Promise<RedisScanResult> {
    this.assertConnected();
    const [nextCursor, rawKeys] = await this.client!.scan(
      cursor, 'MATCH', pattern, 'COUNT', count
    );

    if (rawKeys.length === 0) {
      return { cursor: nextCursor, keys: [] };
    }

    // pipeline 批量获取 TYPE + TTL
    const pipeline = this.client!.pipeline();
    for (const key of rawKeys) {
      pipeline.type(key);
      pipeline.ttl(key);
    }
    const results = await pipeline.exec();
    if (!results) {
      return { cursor: nextCursor, keys: rawKeys.map((key) => ({ key, type: 'unknown' as const, ttl: -1 })) };
    }

    const keys: RedisKeyInfo[] = rawKeys.map((key, i) => ({
      key,
      type: parseKeyType(String(results?.[i * 2]?.[1] ?? 'unknown')),
      ttl: Number(results?.[i * 2 + 1]?.[1] ?? -1),
    }));

    return { cursor: nextCursor, keys };
  }

  async getString(key: string): Promise<string | null> {
    this.assertConnected();
    return this.client!.get(key);
  }

  async getHash(key: string): Promise<Record<string, string>> {
    this.assertConnected();
    return this.client!.hgetall(key);
  }

  async hashScan(
    key: string, cursor: string, count: number
  ): Promise<{ readonly cursor: string; readonly fields: Record<string, string> }> {
    this.assertConnected();
    const [nextCursor, result] = await this.client!.hscan(key, cursor, 'COUNT', count);
    const fields: Record<string, string> = {};
    for (let i = 0; i < result.length; i += 2) {
      fields[result[i]] = result[i + 1];
    }
    return { cursor: nextCursor, fields };
  }

  async getList(key: string, start: number, stop: number): Promise<readonly string[]> {
    this.assertConnected();
    return this.client!.lrange(key, start, stop);
  }

  async getSet(
    key: string, cursor: string, count: number
  ): Promise<{ readonly cursor: string; readonly members: readonly string[] }> {
    this.assertConnected();
    const [nextCursor, members] = await this.client!.sscan(key, cursor, 'COUNT', count);
    return { cursor: nextCursor, members };
  }

  async getZSet(
    key: string, start: number, stop: number
  ): Promise<readonly { readonly member: string; readonly score: number }[]> {
    this.assertConnected();
    const raw = await this.client!.zrange(key, start, stop, 'WITHSCORES');
    // raw 是 [member1, score1, member2, score2, ...]
    const result: { readonly member: string; readonly score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      result.push({ member: raw[i], score: Number(raw[i + 1]) });
    }
    return result;
  }

  async setString(key: string, value: string, ttl?: number): Promise<void> {
    this.assertConnected();
    if (ttl !== undefined && ttl > 0) {
      await this.client!.set(key, value, 'EX', ttl);
    } else {
      await this.client!.set(key, value);
    }
  }

  async setHashField(key: string, field: string, value: string): Promise<void> {
    this.assertConnected();
    await this.client!.hset(key, field, value);
  }

  async deleteHashField(key: string, field: string): Promise<void> {
    this.assertConnected();
    await this.client!.hdel(key, field);
  }

  async listPush(key: string, value: string, position: 'head' | 'tail'): Promise<void> {
    this.assertConnected();
    if (position === 'head') {
      await this.client!.lpush(key, value);
    } else {
      await this.client!.rpush(key, value);
    }
  }

  async listSet(key: string, index: number, value: string): Promise<void> {
    this.assertConnected();
    await this.client!.lset(key, index, value);
  }

  async listRemove(key: string, index: number): Promise<void> {
    this.assertConnected();
    const tombstone = `__DEL_${crypto.randomUUID()}__`;
    await this.client!.lset(key, index, tombstone);
    await this.client!.lrem(key, 1, tombstone);
  }

  async setAdd(key: string, member: string): Promise<void> {
    this.assertConnected();
    await this.client!.sadd(key, member);
  }

  async setRemove(key: string, member: string): Promise<void> {
    this.assertConnected();
    await this.client!.srem(key, member);
  }

  async zsetAdd(key: string, member: string, score: number): Promise<void> {
    this.assertConnected();
    await this.client!.zadd(key, score, member);
  }

  async zsetRemove(key: string, member: string): Promise<void> {
    this.assertConnected();
    await this.client!.zrem(key, member);
  }

  async deleteKey(key: string): Promise<void> {
    this.assertConnected();
    await this.client!.del(key);
  }

  async getKeyType(key: string): Promise<RedisKeyType> {
    this.assertConnected();
    const raw = await this.client!.type(key);
    return parseKeyType(raw);
  }

  async getTTL(key: string): Promise<number> {
    this.assertConnected();
    return this.client!.ttl(key);
  }

  async setTTL(key: string, ttl: number): Promise<void> {
    this.assertConnected();
    await this.client!.expire(key, ttl);
  }

  async removeTTL(key: string): Promise<void> {
    this.assertConnected();
    await this.client!.persist(key);
  }

  async getListLength(key: string): Promise<number> {
    this.assertConnected();
    return this.client!.llen(key);
  }

  async getZSetLength(key: string): Promise<number> {
    this.assertConnected();
    return this.client!.zcard(key);
  }

  async executeCommand(args: readonly string[]): Promise<unknown> {
    this.assertConnected();
    if (args.length === 0) {
      throw new Error('No command provided');
    }
    const [command, ...rest] = args;
    return this.client!.call(command, ...rest);
  }

  private assertConnected(): void {
    if (!this.client) {
      throw new Error('Redis driver is not connected');
    }
  }
}
