import Redis, { type RedisOptions } from 'ioredis';
import type { ConnectionConfig } from '../types/connection.js';
import type { IRedisDriver } from '../types/redis-driver.js';
import type { RedisDbInfo, RedisKeyInfo, RedisKeyType, RedisRawKey, RedisScanResult } from '../types/redis.js';

// CLI / MCP 任意命令的单条超时: BLPOP 0 之类的阻塞命令到点失败, 不会无限占着连接
const RAW_COMMAND_TIMEOUT_MS = 30_000;
// 这些命令把连接切成推送模式, 不会回单个 reply
const STREAMING_COMMANDS = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR']);
const EXPORT_SCAN_COUNT = 1000;
// 导入时单条 HSET / RPUSH / SADD / ZADD 的参数个数上限; 取偶数, 不拆散 field-value / score-member 对
const WRITE_CHUNK = 1000;
const WRITE_COMMANDS: Readonly<Record<string, string>> = {
  string: 'SET', hash: 'HSET', list: 'RPUSH', set: 'SADD', zset: 'ZADD',
};

function parseKeyType(raw: string): RedisKeyType {
  const normalized = raw.toLowerCase();
  if (normalized === 'string' || normalized === 'hash' || normalized === 'list'
    || normalized === 'set' || normalized === 'zset' || normalized === 'stream') {
    return normalized;
  }
  return 'unknown';
}

// 跑完一整轮 SCAN / HSCAN / SSCAN, 收齐所有元素
async function scanAll(scanPage: (cursor: string) => Promise<[Buffer, Buffer[]]>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let cursor = '0';
  do {
    const [next, items] = await scanPage(cursor);
    for (const item of items) { out.push(item); }
    cursor = next.toString();
  } while (cursor !== '0');
  return out;
}

export class RedisDriver implements IRedisDriver {
  readonly driverType = 'redis' as const;
  // 主 client 连连接配置的库, 心跳 / INFO 也走它; 其它库各懒建一条 duplicate 按库号缓存.
  // 每个操作显式带库号, 落在该库自己的 client 上, 共享连接上从不 SELECT, 并发消息不会互相改库.
  private client: Redis | null = null;
  private clientDb = 0;
  private readonly dbClients = new Map<number, Promise<Redis>>();

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    const db = config.database ? Number(config.database) : 0;
    const client = new Redis({
      host: config.host,
      port: config.port,
      username: config.username || undefined,
      password: config.password || undefined,
      db,
      connectTimeout: 5000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    try {
      await client.connect();
      await client.ping();
      // ioredis 建连时 SELECT 失败只 emit error, 命令会静默落在 db0; 显式 SELECT 让越界库号在这里报错
      if (db !== 0) { await client.select(db); }
    } catch (err) {
      // connect 失败后 ioredis 仍按 retryStrategy 在后台重连, 不断开会留下僵尸连接
      client.disconnect();
      throw err;
    }
    this.client = client;
    this.clientDb = db;
  }

  async disconnect(): Promise<void> {
    for (const pending of this.dbClients.values()) {
      pending.then((c) => c.disconnect(), () => undefined);
    }
    this.dbClients.clear();
    if (this.client) {
      this.client.disconnect();
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

  async scan(db: number, pattern: string, cursor: string, count: number): Promise<RedisScanResult> {
    const client = await this.clientFor(db);
    const [nextCursor, rawKeys] = await client.scan(
      cursor, 'MATCH', pattern, 'COUNT', count
    );

    if (rawKeys.length === 0) {
      return { cursor: nextCursor, keys: [] };
    }

    // pipeline 批量获取 TYPE + TTL
    const pipeline = client.pipeline();
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

  async getString(db: number, key: string): Promise<string | null> {
    return (await this.clientFor(db)).get(key);
  }

  async hashScan(
    db: number, key: string, cursor: string, count: number
  ): Promise<{ readonly cursor: string; readonly fields: Record<string, string> }> {
    const [nextCursor, result] = await (await this.clientFor(db)).hscan(key, cursor, 'COUNT', count);
    const fields: Record<string, string> = {};
    for (let i = 0; i < result.length; i += 2) {
      fields[result[i]] = result[i + 1];
    }
    return { cursor: nextCursor, fields };
  }

  async getList(db: number, key: string, start: number, stop: number): Promise<readonly string[]> {
    return (await this.clientFor(db)).lrange(key, start, stop);
  }

  async getSet(
    db: number, key: string, cursor: string, count: number
  ): Promise<{ readonly cursor: string; readonly members: readonly string[] }> {
    const [nextCursor, members] = await (await this.clientFor(db)).sscan(key, cursor, 'COUNT', count);
    return { cursor: nextCursor, members };
  }

  async getZSet(
    db: number, key: string, start: number, stop: number
  ): Promise<readonly { readonly member: string; readonly score: number }[]> {
    const raw = await (await this.clientFor(db)).zrange(key, start, stop, 'WITHSCORES');
    // raw 是 [member1, score1, member2, score2, ...]
    const result: { readonly member: string; readonly score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      result.push({ member: raw[i], score: Number(raw[i + 1]) });
    }
    return result;
  }

  // 不传 ttl 时保留 key 原有 TTL: 裸 SET 会清掉 TTL, KEEPTTL 要 Redis 6+, 所以先读 PTTL 再 SET PX
  async setString(db: number, key: string, value: string, ttl?: number): Promise<void> {
    const client = await this.clientFor(db);
    if (ttl !== undefined && ttl > 0) {
      await client.set(key, value, 'EX', ttl);
      return;
    }
    const pttl = await client.pttl(key);
    if (pttl > 0) {
      await client.set(key, value, 'PX', pttl);
    } else {
      await client.set(key, value);
    }
  }

  async setHashField(db: number, key: string, field: string, value: string): Promise<void> {
    await (await this.clientFor(db)).hset(key, field, value);
  }

  async deleteHashField(db: number, key: string, field: string): Promise<void> {
    await (await this.clientFor(db)).hdel(key, field);
  }

  async listPush(db: number, key: string, value: string, position: 'head' | 'tail'): Promise<void> {
    const client = await this.clientFor(db);
    if (position === 'head') {
      await client.lpush(key, value);
    } else {
      await client.rpush(key, value);
    }
  }

  async listSet(db: number, key: string, index: number, value: string): Promise<void> {
    await (await this.clientFor(db)).lset(key, index, value);
  }

  async listRemove(db: number, key: string, index: number): Promise<void> {
    const client = await this.clientFor(db);
    const tombstone = `__DEL_${crypto.randomUUID()}__`;
    await client.lset(key, index, tombstone);
    await client.lrem(key, 1, tombstone);
  }

  async setAdd(db: number, key: string, member: string): Promise<void> {
    await (await this.clientFor(db)).sadd(key, member);
  }

  async setRemove(db: number, key: string, member: string): Promise<void> {
    await (await this.clientFor(db)).srem(key, member);
  }

  async zsetAdd(db: number, key: string, member: string, score: number): Promise<void> {
    await (await this.clientFor(db)).zadd(key, score, member);
  }

  async zsetRemove(db: number, key: string, member: string): Promise<void> {
    await (await this.clientFor(db)).zrem(key, member);
  }

  async deleteKey(db: number, key: string): Promise<void> {
    await (await this.clientFor(db)).del(key);
  }

  async getKeyType(db: number, key: string): Promise<RedisKeyType> {
    return parseKeyType(await (await this.clientFor(db)).type(key));
  }

  async getTTL(db: number, key: string): Promise<number> {
    return (await this.clientFor(db)).ttl(key);
  }

  async setTTL(db: number, key: string, ttl: number): Promise<void> {
    await (await this.clientFor(db)).expire(key, ttl);
  }

  async removeTTL(db: number, key: string): Promise<void> {
    await (await this.clientFor(db)).persist(key);
  }

  async getListLength(db: number, key: string): Promise<number> {
    return (await this.clientFor(db)).llen(key);
  }

  async getZSetLength(db: number, key: string): Promise<number> {
    return (await this.clientFor(db)).zcard(key);
  }

  async scanAllKeys(db: number, pattern: string): Promise<Buffer[]> {
    const client = await this.clientFor(db);
    const keys = await scanAll((cursor) => client.scanBuffer(cursor, 'MATCH', pattern, 'COUNT', EXPORT_SCAN_COUNT));
    // SCAN 在 rehash 期间可能重复返回同一个 key; latin1 是字节到字符串的一一映射, 作去重键
    return [...new Map(keys.map((k) => [k.toString('latin1'), k])).values()];
  }

  async readKeyRaw(db: number, key: Buffer): Promise<RedisRawKey> {
    const client = await this.clientFor(db);
    const type = await client.type(key);
    let items: Buffer[];
    switch (type) {
      case 'string': {
        const value = await client.getBuffer(key);
        items = value === null ? [] : [value];
        break;
      }
      case 'hash':
        items = await scanAll((cursor) => client.hscanBuffer(key, cursor, 'COUNT', EXPORT_SCAN_COUNT));
        break;
      case 'list':
        items = await client.lrangeBuffer(key, 0, -1);
        break;
      case 'set':
        items = await scanAll((cursor) => client.sscanBuffer(key, cursor, 'COUNT', EXPORT_SCAN_COUNT));
        break;
      case 'zset':
        items = await client.zrangeBuffer(key, 0, -1, 'WITHSCORES');
        break;
      default:
        return { type, ttl: -1, items: [] };
    }
    const ttl = await client.ttl(key);
    // TYPE 之后 key 被删或过期: 值读成 null / 空集合, 或 TTL 为 -2
    if (items.length === 0 || ttl === -2) {
      return { type: 'none', ttl: -1, items: [] };
    }
    return { type, ttl, items };
  }

  async countExistingKeys(db: number, keys: readonly Buffer[]): Promise<number> {
    const client = await this.clientFor(db);
    let existing = 0;
    for (let i = 0; i < keys.length; i += WRITE_CHUNK) {
      existing += await client.exists(...keys.slice(i, i + WRITE_CHUNK));
    }
    return existing;
  }

  async writeKeyRaw(db: number, key: Buffer, raw: RedisRawKey): Promise<void> {
    const command = WRITE_COMMANDS[raw.type];
    if (!command) {
      throw new Error(`Unsupported type: ${raw.type}`);
    }
    // ZRANGE WITHSCORES 的顺序是 member, score; ZADD 要 score, member: 相邻两项互换
    const items = raw.type === 'zset' ? raw.items.map((_, i, all) => all[i ^ 1]) : raw.items;
    const tx = (await this.clientFor(db)).multi().del(key);
    for (let i = 0; i < items.length; i += WRITE_CHUNK) {
      tx.call(command, key, ...items.slice(i, i + WRITE_CHUNK));
    }
    if (raw.ttl > 0) {
      tx.expire(key, raw.ttl);
    }
    // MULTI 里单条命令出错不会 reject exec, 要逐条检查
    const results = await tx.exec();
    const failed = results?.find(([err]) => err);
    if (failed) {
      throw failed[0];
    }
  }

  async executeCommandInDb(db: number | undefined, args: readonly string[]): Promise<unknown> {
    this.assertConnected();
    if (args.length === 0) {
      throw new Error('No command provided');
    }
    const [command, ...rest] = args;
    const name = command.toUpperCase();
    if (STREAMING_COMMANDS.has(name)) {
      throw new Error(`${name} streams replies instead of returning one and cannot run here; use redis-cli`);
    }
    const client = await this.openDbClient(db ?? this.clientDb, { commandTimeout: RAW_COMMAND_TIMEOUT_MS });
    try {
      return await client.call(command, ...rest);
    } finally {
      client.disconnect();
    }
  }

  // 该库的常驻 client: 配置库用主 client, 其它库首次使用时建好并缓存; 建连失败不缓存, 下次重试
  private clientFor(db: number): Promise<Redis> {
    this.assertConnected();
    if (db === this.clientDb) {
      return Promise.resolve(this.client!);
    }
    const cached = this.dbClients.get(db);
    if (cached) {
      return cached;
    }
    const pending = this.openDbClient(db);
    this.dbClients.set(db, pending);
    pending.catch(() => {
      if (this.dbClients.get(db) === pending) { this.dbClients.delete(db); }
    });
    return pending;
  }

  // 从主 client 复制出一条连到 db 的新连接 (同 host / port, 经同一条 SSH tunnel).
  // ioredis 建连时 SELECT 失败只 emit error, 命令会静默落在 db0, 所以非 0 库显式 SELECT 一次, 越界库号直接报错
  private async openDbClient(db: number, options: Partial<RedisOptions> = {}): Promise<Redis> {
    const client = this.client!.duplicate({ ...options, db });
    try {
      if (db !== 0) { await client.select(db); }
      return client;
    } catch (err) {
      client.disconnect();
      throw err;
    }
  }

  private assertConnected(): void {
    if (!this.client) {
      throw new Error('Redis driver is not connected');
    }
  }
}
