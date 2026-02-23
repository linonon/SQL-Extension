import type { IRedisDriver } from '../types/redis-driver.js';
import type { RedisValue, RedisExportKeyEntry, RedisExportData } from '../types/redis.js';
import type { WebviewMessage } from '../types/messages.js';

const HASH_SCAN_COUNT = 100;
const SET_SCAN_COUNT = 100;

/**
 * 解析命令字符串, 支持双引号和单引号包裹的参数.
 * 例: SET key "hello world" -> ['SET', 'key', 'hello world']
 */
export function parseCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
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
        await driver.selectDatabase(message.database);
        const result = await driver.scan(message.pattern, message.cursor, message.count);
        postMessage({
          type: 'redisScanResult',
          keys: result.keys,
          cursor: result.cursor,
          done: result.cursor === '0',
        });
        return true;
      }

      case 'redisGetValue': {
        await driver.selectDatabase(message.database);
        const keyType = await driver.getKeyType(message.key);
        const ttl = await driver.getTTL(message.key);
        let value: RedisValue;
        switch (keyType) {
          case 'string': {
            const strVal = await driver.getString(message.key);
            value = { type: 'string', value: strVal ?? '' };
            break;
          }
          case 'hash': {
            const hashResult = await driver.hashScan(message.key, '0', HASH_SCAN_COUNT);
            value = { type: 'hash', value: hashResult.fields, cursor: hashResult.cursor };
            break;
          }
          case 'list': {
            const total = await driver.getListLength(message.key);
            const listStart = message.listStart ?? 0;
            const listVal = await driver.getList(message.key, listStart, listStart + 99);
            value = { type: 'list', value: listVal, total };
            break;
          }
          case 'set': {
            const setCursor = message.setCursor ?? '0';
            const setResult = await driver.getSet(message.key, setCursor, SET_SCAN_COUNT);
            value = { type: 'set', value: setResult.members, cursor: setResult.cursor };
            break;
          }
          case 'zset': {
            const total = await driver.getZSetLength(message.key);
            const zsetStart = message.zsetStart ?? 0;
            const zsetVal = await driver.getZSet(message.key, zsetStart, zsetStart + 99);
            value = { type: 'zset', value: zsetVal, total };
            break;
          }
          default: {
            value = { type: 'string', value: `[Unsupported type: ${keyType}]` };
            break;
          }
        }
        postMessage({
          type: 'redisValueResult',
          key: message.key,
          keyType,
          value,
          ttl,
        });
        return true;
      }

      case 'redisHashScan': {
        await driver.selectDatabase(message.database);
        const hashScanResult = await driver.hashScan(message.key, message.cursor, message.count);
        postMessage({
          type: 'redisHashScanResult',
          key: message.key,
          cursor: hashScanResult.cursor,
          fields: hashScanResult.fields,
          done: hashScanResult.cursor === '0',
        });
        return true;
      }

      case 'redisSetString': {
        await driver.selectDatabase(message.database);
        await driver.setString(message.key, message.value, message.ttl);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisHashSet': {
        await driver.selectDatabase(message.database);
        await driver.setHashField(message.key, message.field, message.value);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisHashDelete': {
        await driver.selectDatabase(message.database);
        await driver.deleteHashField(message.key, message.field);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisListPush': {
        await driver.selectDatabase(message.database);
        await driver.listPush(message.key, message.value, message.position);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisListSet': {
        await driver.selectDatabase(message.database);
        await driver.listSet(message.key, message.index, message.value);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisListRemove': {
        await driver.selectDatabase(message.database);
        await driver.listRemove(message.key, message.index);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisListBatchSet': {
        await driver.selectDatabase(message.database);
        const listErrors: string[] = [];
        for (const entry of message.entries) {
          try {
            await driver.listSet(message.key, entry.index, entry.value);
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
        await driver.selectDatabase(message.database);
        await driver.setAdd(message.key, message.member);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisSetRemove': {
        await driver.selectDatabase(message.database);
        await driver.setRemove(message.key, message.member);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisZSetAdd': {
        await driver.selectDatabase(message.database);
        await driver.zsetAdd(message.key, message.member, message.score);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisZSetRemove': {
        await driver.selectDatabase(message.database);
        await driver.zsetRemove(message.key, message.member);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisSetEdit': {
        await driver.selectDatabase(message.database);
        await driver.setRemove(message.key, message.oldMember);
        await driver.setAdd(message.key, message.newMember);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisHashBatchSet': {
        await driver.selectDatabase(message.database);
        const errors: string[] = [];
        for (const entry of message.entries) {
          try {
            await driver.setHashField(message.key, entry.field, entry.value);
          } catch (e) {
            errors.push(`${entry.field}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (errors.length > 0) {
          postMessage({ type: 'redisOperationResult', success: false, error: `Failed fields: ${errors.join('; ')}` });
        } else {
          postMessage({ type: 'redisOperationResult', success: true });
        }
        return true;
      }

      case 'redisHashBatchEdit': {
        await driver.selectDatabase(message.database);
        const hashEditErrors: string[] = [];
        for (const edit of message.edits) {
          try {
            await driver.setHashField(message.key, edit.newField, edit.value);
            if (edit.oldField !== edit.newField) {
              await driver.deleteHashField(message.key, edit.oldField);
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
        await driver.selectDatabase(message.database);
        const zsetEditErrors: string[] = [];
        for (const edit of message.edits) {
          try {
            await driver.zsetAdd(message.key, edit.newMember, edit.score);
            if (edit.oldMember !== edit.newMember) {
              await driver.zsetRemove(message.key, edit.oldMember);
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
        await driver.selectDatabase(message.database);
        const editErrors: string[] = [];
        for (const edit of message.edits) {
          try {
            await driver.setRemove(message.key, edit.oldMember);
            await driver.setAdd(message.key, edit.newMember);
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
        await driver.selectDatabase(message.database);
        for (const key of message.keys) {
          await driver.deleteKey(key);
        }
        postMessage({ type: 'redisDeleteKeysResult', success: true, deletedKeys: message.keys });
        return true;
      }

      case 'redisSetTTL': {
        await driver.selectDatabase(message.database);
        await driver.setTTL(message.key, message.ttl);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisRemoveTTL': {
        await driver.selectDatabase(message.database);
        await driver.removeTTL(message.key);
        postMessage({ type: 'redisOperationResult', success: true });
        return true;
      }

      case 'redisExecuteCommand': {
        await driver.selectDatabase(message.database);
        const args = parseCommandArgs(message.command);
        const result = await driver.executeCommand(args);
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

const EXPORT_SET_SCAN_COUNT = 1000;

async function collectAllSetMembers(driver: IRedisDriver, key: string): Promise<readonly string[]> {
  const members: string[] = [];
  let cursor = '0';
  do {
    const result = await driver.getSet(key, cursor, EXPORT_SET_SCAN_COUNT);
    members.push(...result.members);
    cursor = result.cursor;
  } while (cursor !== '0');
  return members;
}

async function readFullKeyValue(
  driver: IRedisDriver,
  key: string
): Promise<RedisExportKeyEntry | null> {
  const type = await driver.getKeyType(key);
  const ttl = await driver.getTTL(key);

  switch (type) {
    case 'string': {
      const val = await driver.getString(key);
      return { key, type, ttl, value: val ?? '' };
    }
    case 'hash': {
      const val = await driver.getHash(key);
      return { key, type, ttl, value: val };
    }
    case 'list': {
      const val = await driver.getList(key, 0, -1);
      return { key, type, ttl, value: val };
    }
    case 'set': {
      const val = await collectAllSetMembers(driver, key);
      return { key, type, ttl, value: val };
    }
    case 'zset': {
      const val = await driver.getZSet(key, 0, -1);
      return { key, type, ttl, value: val };
    }
    default:
      return null;
  }
}

export async function exportRedisKeys(
  driver: IRedisDriver,
  database: number,
  keys: readonly string[]
): Promise<{ readonly json: string; readonly keyCount: number; readonly errors: readonly string[] }> {
  await driver.selectDatabase(database);
  const entries: RedisExportKeyEntry[] = [];
  const errors: string[] = [];

  for (const key of keys) {
    try {
      const entry = await readFullKeyValue(driver, key);
      if (entry) {
        entries.push(entry);
      }
    } catch (e) {
      errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const data: RedisExportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    database,
    keys: entries,
  };

  return { json: JSON.stringify(data, null, 2), keyCount: entries.length, errors };
}

export async function importRedisKeys(
  driver: IRedisDriver,
  database: number,
  jsonContent: string
): Promise<{ readonly importedCount: number; readonly errors: readonly string[] }> {
  const data = JSON.parse(jsonContent) as Record<string, unknown>;

  if (data.version !== 1) {
    throw new Error(`Unsupported export version: ${data.version}`);
  }
  if (!Array.isArray(data.keys)) {
    throw new Error('Invalid export file: missing keys array');
  }

  await driver.selectDatabase(database);
  const entries = data.keys as readonly RedisExportKeyEntry[];
  const errors: string[] = [];
  let importedCount = 0;

  for (const entry of entries) {
    try {
      switch (entry.type) {
        case 'string': {
          await driver.setString(entry.key, entry.value as string);
          break;
        }
        case 'hash': {
          await driver.deleteKey(entry.key);
          const fields = entry.value as Record<string, string>;
          for (const [field, val] of Object.entries(fields)) {
            await driver.setHashField(entry.key, field, val);
          }
          break;
        }
        case 'list': {
          await driver.deleteKey(entry.key);
          const items = entry.value as readonly string[];
          for (const item of items) {
            await driver.listPush(entry.key, item, 'tail');
          }
          break;
        }
        case 'set': {
          await driver.deleteKey(entry.key);
          const members = entry.value as readonly string[];
          for (const member of members) {
            await driver.setAdd(entry.key, member);
          }
          break;
        }
        case 'zset': {
          await driver.deleteKey(entry.key);
          const zMembers = entry.value as readonly { readonly member: string; readonly score: number }[];
          for (const m of zMembers) {
            await driver.zsetAdd(entry.key, m.member, m.score);
          }
          break;
        }
        default:
          continue;
      }
      if (entry.ttl > 0) {
        await driver.setTTL(entry.key, entry.ttl);
      }
      importedCount++;
    } catch (e) {
      errors.push(`${entry.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { importedCount, errors };
}
