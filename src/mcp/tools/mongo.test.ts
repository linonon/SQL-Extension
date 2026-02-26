import { describe, it, expect } from 'vitest';
import { validatePipeline, buildMongoShellQuery } from './mongo.js';

describe('mongo_query - validatePipeline', () => {
  it('should allow read-only stages', () => {
    expect(() => validatePipeline([
      { $match: { status: 'active' } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ])).not.toThrow();
  });

  it('should reject $out stage', () => {
    expect(() => validatePipeline([
      { $match: { status: 'active' } },
      { $out: 'results' },
    ])).toThrow('$out');
  });

  it('should reject $merge stage', () => {
    expect(() => validatePipeline([
      { $match: {} },
      { $merge: { into: 'output' } },
    ])).toThrow('$merge');
  });

  it('should allow empty pipeline', () => {
    expect(() => validatePipeline([])).not.toThrow();
  });

  it('should reject $out even if mixed with other keys', () => {
    // 虽然实际 MongoDB 不允许, 但校验应该逐 key 检查
    expect(() => validatePipeline([
      { $match: { x: 1 }, $out: 'bad' } as Record<string, unknown>,
    ])).toThrow('$out');
  });
});

describe('mongo_query - buildMongoShellQuery', () => {
  it('should build find query without projection', () => {
    const q = buildMongoShellQuery('users', 'find', { age: 18 });
    expect(q).toBe('db.users.find({"age":18})');
  });

  it('should build find query with projection', () => {
    const q = buildMongoShellQuery('users', 'find', { active: true }, undefined, { name: 1, email: 1 });
    expect(q).toBe('db.users.find({"active":true}, {"projection": {"name":1,"email":1}})');
  });

  it('should build find query with empty filter', () => {
    const q = buildMongoShellQuery('users', 'find');
    expect(q).toBe('db.users.find({})');
  });

  it('should build aggregate query', () => {
    const pipeline = [{ $match: { status: 'A' } }, { $group: { _id: '$cust_id', total: { $sum: '$amount' } } }];
    const q = buildMongoShellQuery('orders', 'aggregate', undefined, pipeline);
    expect(q).toBe(`db.orders.aggregate(${JSON.stringify(pipeline)})`);
  });

  it('should build countDocuments query', () => {
    const q = buildMongoShellQuery('users', 'countDocuments', { active: true });
    expect(q).toBe('db.users.countDocuments({"active":true})');
  });

  it('should build countDocuments with empty filter', () => {
    const q = buildMongoShellQuery('users', 'countDocuments');
    expect(q).toBe('db.users.countDocuments({})');
  });

  it('should throw on unsupported method', () => {
    expect(() => buildMongoShellQuery('users', 'drop')).toThrow('Unsupported method');
  });
});
