import { isUtf8 } from 'node:buffer';
import type { IRedisDriver } from '../types/redis-driver.js';
import type { RedisValue, RedisExportBytes, RedisExportData, RedisExportKeyEntry, RedisExportType, RedisRawKey } from '../types/redis.js';
import type { WebviewMessage } from '../types/messages.js';

const HASH_SCAN_COUNT = 100;
const SET_SCAN_COUNT = 100;

// Set TTL 输入框校验: 只收 -1 (移除 TTL) 或 >= 1 的整数; EXPIRE 0 会直接删 key, 不放行
export function validateTtlInput(v: string): string | undefined {
  if (v.trim() === '') { return 'TTL is required'; }
  const n = Number(v);
  if (!Number.isInteger(n) || (n !== -1 && n < 1)) { return 'Must be -1 (remove TTL) or an integer >= 1'; }
  return undefined;
}

/**
 * 解析命令字符串, 支持双引号和单引号包裹的参数.
 * 双引号内 \" 和 \\ 转义为 " 和 \, 其余反斜杠原样保留; 引号包裹的空串 ("") 是一个空参数.
 * 例: SET k "{\"open\":true}" -> ['SET', 'k', '{"open":true}']
 */
export function parseCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;
  // 当前 token 出现过引号: 即使内容为空也要作为参数保留
  let quoted = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else if (inQuote === '"' && ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        current += command[++i];
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (current.length > 0 || quoted) {
        args.push(current);
        current = '';
        quoted = false;
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0 || quoted) {
    args.push(current);
  }

  return args;
}

/**
 * 处理 redis 相关的 webview message.
 * 返回 true 表示已处理, false 表示不是 redis 消息.
 */
export async function handleRedisMessage(
  message: WebviewMessage,
  driver: IRedisDriver,
  postMessage: (msg: unknown) => void
): Promise<boolean> {
  try {
    switch (message.type) {
      case 'redisScan': {
        const result = await driver.scan(message.database, message.pattern, message.cursor, message.count);
        postMessage({
          type: 'redisScanResult',
          requestId: message.requestId,
          keys: result.keys,
          cursor: result.cursor,
          done: result.cursor === '0',
          scanned: result.scanned,
        });
        return true;
      }

      case 'redisGetValue': {
        const rawType = await driver.getKeyType(message.database, message.key);
        const ttl = await driver.getTTL(message.database, message.key);
        let value: RedisValue;
        switch (rawType) {
          case 'string': {
            const strVal = await driver.getString(message.database, message.key);
            value = { type: 'string', value: strVal ?? '' };
            break;
          }
          case 'hash': {
            const hashResult = await driver.hashScan(message.database, message.key, '0', HASH_SCAN_COUNT);
            value = { type: 'hash', value: hashResult.fields, cursor: hashResult.cursor };
            break;
          }
          case 'list': {
            const total = await driver.getListLength(message.database, message.key);
            const listStart = message.listStart ?? 0;
            const listVal = await driver.getList(message.database, message.key, listStart, listStart + 99);
            value = { type: 'list', value: listVal, total, start: listStart };
            break;
          }
          case 'set': {
            const setCursor = message.setCursor ?? '0';
            const setResult = await driver.getSet(message.database, message.key, setCursor, SET_SCAN_COUNT);
            value = { type: 'set', value: setResult.members, cursor: setResult.cursor };
            break;
          }
          case 'zset': {
            const total = await driver.getZSetLength(message.database, message.key);
            const zsetStart = message.zsetStart ?? 0;
            const zsetVal = await driver.getZSet(message.database, message.key, zsetStart, zsetStart + 99);
            value = { type: 'zset', value: zsetVal, total, start: zsetStart };
            break;
          }
          default: {
            // stream / 模块类型 / 已不存在 ('none'): 不读值, webview 只读显示类型名
            value = { type: 'unsupported', typeName: rawType };
            break;
          }
        }
        postMessage({
          type: 'redisValueResult',
          key: message.key,
          database: message.database,
          keyType: value.type !== 'unsupported' ? value.type : rawType === 'stream' ? 'stream' : 'unknown',
          value,
          ttl,
        });
        return true;
      }

      case 'redisHashScan': {
        const hashScanResult = await driver.hashScan(message.database, message.key, message.cursor, message.count);
        postMessage({
          type: 'redisHashScanResult',
          key: message.key,
          database: message.database,
          cursor: hashScanResult.cursor,
          fields: hashScanResult.fields,
          done: hashScanResult.cursor === '0',
        });
        return true;
      }

      case 'redisSetString': {
        await driver.setString(message.database, message.key, message.value, message.ttl);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisHashDelete': {
        await driver.deleteHashField(message.database, message.key, message.field);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisListPush': {
        await driver.listPush(message.database, message.key, message.value, message.position);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisListRemove': {
        await driver.listRemove(message.database, message.key, message.index);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisListBatchSet': {
        const listErrors: string[] = [];
        for (const entry of message.entries) {
          try {
            await driver.listSet(message.database, message.key, entry.index, entry.value);
          } catch (e) {
            listErrors.push(`[${entry.index}]: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (listErrors.length > 0) {
          postMessage({ type: 'redisOperationResult', success: false, error: `Failed items: ${listErrors.join('; ')}` });
        } else {
          postMessage({ type: 'redisOperationResult', success: true });
        }
        return true;
      }

      case 'redisSetAdd': {
        await driver.setAdd(message.database, message.key, message.member);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisSetRemove': {
        await driver.setRemove(message.database, message.key, message.member);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisZSetAdd': {
        await driver.zsetAdd(message.database, message.key, message.member, message.score);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisZSetRemove': {
        await driver.zsetRemove(message.database, message.key, message.member);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisHashBatchEdit': {
        const hashEditErrors: string[] = [];
        for (const edit of message.edits) {
          try {
            await driver.setHashField(message.database, message.key, edit.newField, edit.value);
            if (edit.oldField !== edit.newField) {
              await driver.deleteHashField(message.database, message.key, edit.oldField);
            }
          } catch (e) {
            hashEditErrors.push(`${edit.oldField}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (hashEditErrors.length > 0) {
          postMessage({ type: 'redisOperationResult', success: false, error: `Failed edits: ${hashEditErrors.join('; ')}` });
        } else {
          postMessage({ type: 'redisOperationResult', success: true });
        }
        return true;
      }

      case 'redisZSetBatchEdit': {
        const zsetEditErrors: string[] = [];
        for (const edit of message.edits) {
          try {
            await driver.zsetAdd(message.database, message.key, edit.newMember, edit.score);
            if (edit.oldMember !== edit.newMember) {
              await driver.zsetRemove(message.database, message.key, edit.oldMember);
            }
          } catch (e) {
            zsetEditErrors.push(`${edit.oldMember}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (zsetEditErrors.length > 0) {
          postMessage({ type: 'redisOperationResult', success: false, error: `Failed edits: ${zsetEditErrors.join('; ')}` });
        } else {
          postMessage({ type: 'redisOperationResult', success: true });
        }
        return true;
      }

      case 'redisSetBatchEdit': {
        const editErrors: string[] = [];
        for (const edit of message.edits) {
          try {
            await driver.setRemove(message.database, message.key, edit.oldMember);
            await driver.setAdd(message.database, message.key, edit.newMember);
          } catch (e) {
            editErrors.push(`${edit.oldMember}->${edit.newMember}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (editErrors.length > 0) {
          postMessage({ type: 'redisOperationResult', success: false, error: `Failed edits: ${editErrors.join('; ')}` });
        } else {
          postMessage({ type: 'redisOperationResult', success: true });
        }
        return true;
      }

      case 'redisDeleteKeys': {
        for (const key of message.keys) {
          await driver.deleteKey(message.database, key);
        }
        postMessage({ type: 'redisDeleteKeysResult', success: true, deletedKeys: message.keys });
        return true;
      }

      case 'redisSetTTL': {
        await driver.setTTL(message.database, message.key, message.ttl);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisRemoveTTL': {
        await driver.removeTTL(message.database, message.key);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisExecuteCommand': {
        const result = await driver.executeCommandInDb(message.database, parseCommandArgs(message.command));
        postMessage({
          type: 'redisCommandResult',
          output: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        });
        return true;
      }

      case 'redisListDatabases': {
        const databases = await driver.listDatabases();
        postMessage({ type: 'redisDbList', databases });
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    postMessage({ type: 'redisOperationResult', success: false, error: errorMsg });
    return true;
  }
}

const EXPORT_TYPES: ReadonlySet<string> = new Set<RedisExportType>(['string', 'hash', 'list', 'set', 'zset']);

export function encodeBytes(buf: Buffer): RedisExportBytes {
  return isUtf8(buf) ? buf.toString('utf8') : { encoding: 'base64', data: buf.toString('base64') };
}

export function decodeBytes(value: unknown): Buffer {
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  const marked = value as { encoding?: unknown; data?: unknown } | null;
  if (marked?.encoding === 'base64' && typeof marked.data === 'string') {
    return Buffer.from(marked.data, 'base64');
  }
  throw new Error('Invalid encoded value: expected a string or {"encoding":"base64","data":"..."}');
}

function mapPairs<T>(items: readonly Buffer[], fn: (a: Buffer, b: Buffer) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    out.push(fn(items[i], items[i + 1]));
  }
  return out;
}

function toExportValue(raw: RedisRawKey): RedisExportKeyEntry['value'] {
  switch (raw.type) {
    case 'string':
      return encodeBytes(raw.items[0]);
    case 'hash':
      return mapPairs(raw.items, (field, value) => ({ field: encodeBytes(field), value: encodeBytes(value) }));
    case 'zset':
      return mapPairs(raw.items, (member, score) => {
        const n = Number(score.toString());
        return { member: encodeBytes(member), score: Number.isFinite(n) ? n : score.toString() };
      });
    default:
      return raw.items.map(encodeBytes);
  }
}

// 导出文件的 value 还原成 driver 的 items; hash 兼容 version 1 的 { field: value } 对象
function toRawItems(entry: { readonly type: string; readonly value: unknown }): Buffer[] {
  const value = entry.value as never;
  switch (entry.type) {
    case 'string':
      return [decodeBytes(value)];
    case 'hash':
      return Array.isArray(value)
        ? (value as { field: unknown; value: unknown }[]).flatMap((p) => [decodeBytes(p.field), decodeBytes(p.value)])
        : Object.entries(value as Record<string, unknown>).flatMap(([field, v]) => [Buffer.from(field, 'utf8'), decodeBytes(v)]);
    case 'list':
    case 'set':
      return (value as unknown[]).map(decodeBytes);
    case 'zset':
      return (value as { member: unknown; score: unknown }[]).flatMap((m) => [decodeBytes(m.member), Buffer.from(String(m.score))]);
    default:
      throw new Error(`Unsupported type: ${entry.type}`);
  }
}

/**
 * 导出一个库里匹配 pattern 的全部 key (服务端 SCAN 跑完整轮), 或单个 key.
 * 不支持的类型和 SCAN 之后消失的 key 不写进文件, 按类型计数放进 skipped (如 "stream x2, vanished x1").
 * onProgress 抛错会中止整个导出 (调用方借此实现取消).
 */
export async function exportRedisKeys(
  driver: IRedisDriver,
  database: number,
  target: { readonly pattern: string } | { readonly key: string },
  onProgress?: (done: number, total: number) => void
): Promise<{ readonly json: string; readonly keyCount: number; readonly skipped: string; readonly errors: readonly string[] }> {
  const keys = 'key' in target ? [Buffer.from(target.key, 'utf8')] : await driver.scanAllKeys(database, target.pattern);
  const entries: RedisExportKeyEntry[] = [];
  const skipped = new Map<string, number>();
  const errors: string[] = [];

  for (const [i, key] of keys.entries()) {
    try {
      const raw = await driver.readKeyRaw(database, key);
      if (EXPORT_TYPES.has(raw.type)) {
        entries.push({ key: encodeBytes(key), type: raw.type as RedisExportType, ttl: raw.ttl, value: toExportValue(raw) });
      } else {
        const label = raw.type === 'none' ? 'vanished' : raw.type;
        skipped.set(label, (skipped.get(label) ?? 0) + 1);
      }
    } catch (e) {
      errors.push(`${key.toString()}: ${e instanceof Error ? e.message : String(e)}`);
    }
    onProgress?.(i + 1, keys.length);
  }

  const data: RedisExportData = {
    version: 2,
    exportedAt: new Date().toISOString(),
    database,
    keys: entries,
  };
  const skippedTotal = [...skipped.values()].reduce((a, b) => a + b, 0);
  const skippedText = skippedTotal === 0 ? ''
    : `skipped ${skippedTotal} key(s): ${[...skipped].map(([type, n]) => `${type} x${n}`).join(', ')}`;

  return { json: JSON.stringify(data, null, 2), keyCount: entries.length, skipped: skippedText, errors };
}

/**
 * 导入导出文件: 同名 key 先删后写 (保留文件里的 TTL), 全部在 database 这个库的 client 上执行.
 * 写之前统计已存在的同名 key, 有则交给 confirmReplace 确认; 用户拒绝返回 null, 一个 key 也不写.
 */
export async function importRedisKeys(
  driver: IRedisDriver,
  database: number,
  jsonContent: string,
  confirmReplace: (existing: number) => Promise<boolean>
): Promise<{ readonly importedCount: number; readonly errors: readonly string[] } | null> {
  const data = JSON.parse(jsonContent) as Record<string, unknown>;

  if (data.version !== 1 && data.version !== 2) {
    throw new Error(`Unsupported export version: ${data.version}`);
  }
  if (!Array.isArray(data.keys)) {
    throw new Error('Invalid export file: missing keys array');
  }

  const entries = data.keys as readonly { readonly key: unknown; readonly type: string; readonly ttl: number; readonly value: unknown }[];
  const keys = entries.map((entry) => decodeBytes(entry.key));
  const existing = await driver.countExistingKeys(database, keys);
  if (existing > 0 && !(await confirmReplace(existing))) {
    return null;
  }

  const errors: string[] = [];
  let importedCount = 0;
  for (const [i, entry] of entries.entries()) {
    try {
      await driver.writeKeyRaw(database, keys[i], { type: entry.type, ttl: entry.ttl, items: toRawItems(entry) });
      importedCount++;
    } catch (e) {
      errors.push(`${keys[i].toString()}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { importedCount, errors };
}
