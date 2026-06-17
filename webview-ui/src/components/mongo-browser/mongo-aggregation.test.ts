import { describe, it, expect } from 'vitest';
import { buildAggregateQuery, type AggStage } from './mongo-aggregation';

function stage(op: string, body: string, enabled = true): AggStage {
  return { op, body, enabled };
}

describe('buildAggregateQuery', () => {
  it('无 stage -> 空 pipeline', () => {
    expect(buildAggregateQuery('users', [])).toBe('db.users.aggregate([])');
  });

  it('单 $match', () => {
    expect(buildAggregateQuery('users', [stage('$match', '{"age": {"$gt": 18}}')]))
      .toBe('db.users.aggregate([{"$match":{"age":{"$gt":18}}}])');
  });

  it('多 stage 按顺序', () => {
    const q = buildAggregateQuery('orders', [
      stage('$match', '{"status": "paid"}'),
      stage('$group', '{"_id": "$cust", "total": {"$sum": "$amt"}}'),
      stage('$sort', '{"total": -1}'),
    ]);
    expect(q).toBe('db.orders.aggregate([{"$match":{"status":"paid"}},{"$group":{"_id":"$cust","total":{"$sum":"$amt"}}},{"$sort":{"total":-1}}])');
  });

  it('disabled stage 跳过', () => {
    const q = buildAggregateQuery('users', [
      stage('$match', '{"a": 1}'),
      stage('$limit', '10', false),
    ]);
    expect(q).toBe('db.users.aggregate([{"$match":{"a":1}}])');
  });

  it('空 body -> 空对象 (如 $count 之外的占位)', () => {
    expect(buildAggregateQuery('c', [stage('$match', '   ')]))
      .toBe('db.c.aggregate([{"$match":{}}])');
  });

  it('body 含 shell 类型 -> 转 EJSON', () => {
    expect(buildAggregateQuery('c', [stage('$match', '{"_id": ObjectId("507f1f77bcf86cd799439011")}')]))
      .toBe('db.c.aggregate([{"$match":{"_id":{"$oid":"507f1f77bcf86cd799439011"}}}])');
  });

  it('非法 JSON body -> 抛错带 stage 序号', () => {
    expect(() => buildAggregateQuery('c', [stage('$match', '{invalid}')]))
      .toThrow(/stage 1/i);
  });
});
