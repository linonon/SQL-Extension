import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// db_read / db_execute 在扩展侧的校验: sql-validator 与 routeByDriver

import { Long, ObjectId } from 'mongodb';
import { isReadonlySQL, enforceLimit } from './sql-validator.js';

describe('query tool - SQL validation integration', () => {
  it('should reject INSERT via isReadonlySQL', () => {
    expect(isReadonlySQL('INSERT INTO users VALUES (1, "test")')).toBe(false);
  });

  it('should reject UPDATE via isReadonlySQL', () => {
    expect(isReadonlySQL('UPDATE users SET name = "x" WHERE id = 1')).toBe(false);
  });

  it('should reject DELETE via isReadonlySQL', () => {
    expect(isReadonlySQL('DELETE FROM users WHERE id = 1')).toBe(false);
  });

  it('should reject DROP TABLE via isReadonlySQL', () => {
    expect(isReadonlySQL('DROP TABLE users')).toBe(false);
  });

  it('should reject multi-statement injection', () => {
    expect(isReadonlySQL('SELECT 1; DROP TABLE users;')).toBe(false);
  });

  it('should allow SELECT and enforce LIMIT', () => {
    expect(isReadonlySQL('SELECT * FROM users')).toBe(true);
    const limited = enforceLimit('SELECT * FROM users');
    expect(limited).toBe('SELECT * FROM users\nLIMIT 500');
  });

  it('should allow WITH CTE queries', () => {
    const sql = 'WITH active AS (SELECT * FROM users WHERE active = true) SELECT * FROM active';
    expect(isReadonlySQL(sql)).toBe(true);
    const limited = enforceLimit(sql);
    expect(limited).toContain('LIMIT 500');
  });

  it('should cap user-specified LIMIT at 500', () => {
    const sql = 'SELECT * FROM users LIMIT 99999';
    expect(isReadonlySQL(sql)).toBe(true);
    const limited = enforceLimit(sql);
    expect(limited).toBe('SELECT * FROM users LIMIT 500');
  });
});

import { routeByDriver, type DriverSource } from './query-router.js';
import type { ToolResult } from '../mcp/tools/mcp-result.js';

const isErr = (r: ToolResult) => 'isError' in r && r.isError === true;

describe('routeByDriver SQL guards', () => {
  const ok = { columns: [], rows: [{ n: 1 }], affectedRows: 0, executionTime: 1 };
  function source() {
    const driver = {
      executeReadOnly: vi.fn().mockResolvedValue(ok),
      executeBatch: vi.fn().mockReturnValue({ promise: Promise.resolve({ results: [{ ...ok, sql: 'x' }] }), cancel: () => {} }),
      execute: vi.fn().mockResolvedValue(ok),
    };
    return { driver, src: { getDriver: () => driver } as unknown as DriverSource };
  }

  it('runs reads through executeReadOnly with the capped query', async () => {
    const { driver, src } = source();
    const r = await routeByDriver('read', 'mysql', 'c', 'SELECT * FROM t', 'db1', src);
    expect(isErr(r)).toBe(false);
    expect(driver.executeReadOnly).toHaveBeenCalledWith('SELECT * FROM t\nLIMIT 500', 'db1');
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('rejects writes in read mode before touching the driver', async () => {
    const { driver, src } = source();
    const r = await routeByDriver('read', 'postgresql', 'c', 'DELETE FROM t', undefined, src);
    expect(isErr(r)).toBe(true);
    expect(driver.executeReadOnly).not.toHaveBeenCalled();
  });

  it('requires a database for MySQL execute', async () => {
    const { driver, src } = source();
    const r = await routeByDriver('execute', 'mysql', 'c', 'DELETE FROM t WHERE id=1', undefined, src);
    expect(isErr(r)).toBe(true);
    expect(driver.executeBatch).not.toHaveBeenCalled();
    await routeByDriver('execute', 'mysql', 'c', 'DELETE FROM t WHERE id=1', 'db1', src);
    expect(driver.executeBatch).toHaveBeenCalledWith(['DELETE FROM t WHERE id=1'], 'db1');
  });

  it('PG 读写都带上目标库 (driver 按库选 pool); 执行的未提交事务提示带进结果', async () => {
    const { driver, src } = source();
    await routeByDriver('read', 'postgresql', 'c', 'SELECT 1', 'app_staging', src);
    expect(driver.executeReadOnly).toHaveBeenCalledWith('SELECT 1\nLIMIT 500', 'app_staging');
    driver.executeBatch.mockReturnValueOnce({ promise: Promise.resolve({ results: [{ ...ok, sql: 'BEGIN' }], warning: 'rolled back' }), cancel: () => {} });
    const r = await routeByDriver('execute', 'postgresql', 'c', 'BEGIN', 'app_staging', src);
    expect(driver.executeBatch).toHaveBeenCalledWith(['BEGIN'], 'app_staging');
    expect(JSON.parse(r.content[0].text).warning).toBe('rolled back');
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('execute 出错原样抛出', async () => {
    const { driver, src } = source();
    driver.executeBatch.mockReturnValueOnce({ promise: Promise.resolve({ results: [], error: { index: 0, cause: new Error('boom') } }), cancel: () => {} });
    await expect(routeByDriver('execute', 'mysql', 'c', 'UPDATE t SET a=1 WHERE id=1', 'db1', src)).rejects.toThrow('boom');
  });

  it('只读查询的服务端超时换成可操作的提示, 其它错误原样抛出', async () => {
    const { driver, src } = source();
    const timeout = /exceeded the 30s read timeout/;
    driver.executeReadOnly.mockRejectedValueOnce(Object.assign(new Error('maximum statement execution time exceeded'), { errno: 3024 }));
    await expect(routeByDriver('read', 'mysql', 'c', 'SELECT 1', 'db1', src)).rejects.toThrow(timeout);
    driver.executeReadOnly.mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    await expect(routeByDriver('read', 'postgresql', 'c', 'SELECT 1', 'db1', src)).rejects.toThrow(timeout);
    driver.executeReadOnly.mockRejectedValueOnce(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
    await expect(routeByDriver('read', 'postgresql', 'c', 'SELECT 1', 'db1', src)).rejects.toThrow('user request');
  });
});

describe('routeByDriver Mongo', () => {
  function mongoSource() {
    const mongo = {
      find: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(3),
      deleteOne: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue(2),
      aggregate: vi.fn().mockResolvedValue([]),
    };
    return { mongo, src: { getMongoDriver: () => mongo } as unknown as DriverSource };
  }

  it('db_read 给 find 传行数上限与 maxTimeMS, 超时报可操作提示; db_execute 不加', async () => {
    const { mongo, src } = mongoSource();
    await routeByDriver('read', 'mongodb', 'c', '{"collection":"2024日志","method":"find","filter":{}}', 'db', src);
    expect(mongo.find).toHaveBeenLastCalledWith('db', '2024日志', {}, { projection: undefined, sort: undefined, skip: undefined, limit: 500, maxTimeMS: 30000 });
    const r = await routeByDriver('execute', 'mongodb', 'c', '{"collection":"u","method":"deleteOne","filter":{"a":1}}', 'db', src);
    expect(mongo.deleteOne).toHaveBeenLastCalledWith('db', 'u', { a: 1 });
    expect(JSON.parse(r.content[0].text)).toEqual({ affectedRows: 1 });

    mongo.count.mockRejectedValueOnce(Object.assign(new Error('operation exceeded time limit'), { code: 50 }));
    await expect(routeByDriver('read', 'mongodb', 'c', '{"collection":"u","method":"countDocuments"}', 'db', src))
      .rejects.toThrow(/exceeded the 30s read timeout/);
  });

  it('find 透传 sort / skip, limit 仍受上限', async () => {
    const { mongo, src } = mongoSource();
    await routeByDriver('read', 'mongodb', 'c', '{"collection":"u","method":"find","filter":{},"sort":{"at":-1},"skip":40,"limit":9999}', 'db', src);
    expect(mongo.find).toHaveBeenLastCalledWith('db', 'u', {}, { projection: undefined, sort: { at: -1 }, skip: 40, limit: 500, maxTimeMS: 30000 });
  });

  it('结果按 relaxed EJSON 输出: ObjectId / Date 带标记, 大 Long 不被舍入也不是 {high, low}', async () => {
    const { mongo, src } = mongoSource();
    const oid = 'aabbccddeeff001122334455';
    mongo.find.mockResolvedValue([{
      _id: new ObjectId(oid), at: new Date('2024-01-01T00:00:00Z'), n: 5,
      big: Long.fromString('9007199254740993'), nested: { ids: [Long.fromString('-9007199254740993')] },
    }]);
    const r = await routeByDriver('read', 'mongodb', 'c', '{"collection":"u","method":"find"}', 'db', src);
    expect(JSON.parse(r.content[0].text).rows).toEqual([{
      _id: { $oid: oid }, at: { $date: '2024-01-01T00:00:00Z' }, n: 5,
      big: { $numberLong: '9007199254740993' }, nested: { ids: [{ $numberLong: '-9007199254740993' }] },
    }]);
  });

  it('update 文档与 aggregate pipeline 里的 EJSON 标记还原成 BSON 再交给 driver', async () => {
    const { mongo, src } = mongoSource();
    const oid = 'aabbccddeeff001122334455';
    await routeByDriver('execute', 'mongodb', 'c',
      `{"collection":"u","method":"updateMany","filter":{"a":1},"update":{"$set":{"ref":{"$oid":"${oid}"},"at":{"$date":"2024-01-01T00:00:00Z"}}}}`, 'db', src);
    const set = mongo.updateMany.mock.calls[0][3].$set;
    expect(set.ref).toBeInstanceOf(ObjectId);
    expect(set.ref.toHexString()).toBe(oid);
    expect(set.at).toBeInstanceOf(Date);

    await routeByDriver('read', 'mongodb', 'c',
      `{"collection":"u","method":"aggregate","pipeline":[{"$match":{"ref":{"$oid":"${oid}"}}}]}`, 'db', src);
    expect(mongo.aggregate.mock.calls[0][2][0].$match.ref).toBeInstanceOf(ObjectId);
  });
});
