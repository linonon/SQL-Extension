import { describe, it, expect } from 'vitest';
import { parseMongoQuery } from './mongo-query-parser';

describe('parseMongoQuery', () => {
  describe('正常解析', () => {
    it('解析 find 无参数', () => {
      const cmd = parseMongoQuery('db.users.find({})');
      expect(cmd.collection).toBe('users');
      expect(cmd.method).toBe('find');
      expect(cmd.args).toEqual([{}]);
    });

    it('解析 find 带 filter', () => {
      const cmd = parseMongoQuery('db.users.find({"name": "Alice"})');
      expect(cmd.collection).toBe('users');
      expect(cmd.method).toBe('find');
      expect(cmd.args).toEqual([{ name: 'Alice' }]);
    });

    it('解析 findOne', () => {
      const cmd = parseMongoQuery('db.orders.findOne({"_id": "abc123"})');
      expect(cmd.method).toBe('findOne');
      expect(cmd.args).toEqual([{ _id: 'abc123' }]);
    });

    it('解析 insertOne', () => {
      const cmd = parseMongoQuery('db.users.insertOne({"name": "Bob", "age": 30})');
      expect(cmd.method).toBe('insertOne');
      expect(cmd.args).toEqual([{ name: 'Bob', age: 30 }]);
    });

    it('解析 updateOne 多参数', () => {
      const cmd = parseMongoQuery('db.users.updateOne({"_id": "x"}, {"$set": {"name": "New"}})');
      expect(cmd.method).toBe('updateOne');
      expect(cmd.args).toEqual([{ _id: 'x' }, { $set: { name: 'New' } }]);
    });

    it('解析 deleteOne', () => {
      const cmd = parseMongoQuery('db.users.deleteOne({"_id": "x"})');
      expect(cmd.method).toBe('deleteOne');
      expect(cmd.args).toEqual([{ _id: 'x' }]);
    });

    it('解析 replaceOne 多参数', () => {
      const cmd = parseMongoQuery('db.users.replaceOne({"_id": "x"}, {"name": "New"})');
      expect(cmd.method).toBe('replaceOne');
      expect(cmd.args).toEqual([{ _id: 'x' }, { name: 'New' }]);
    });

    it('解析 deleteMany', () => {
      const cmd = parseMongoQuery('db.logs.deleteMany({"level": "debug"})');
      expect(cmd.method).toBe('deleteMany');
      expect(cmd.args).toEqual([{ level: 'debug' }]);
    });

    it('解析 aggregate', () => {
      const cmd = parseMongoQuery('db.orders.aggregate([{"$group": {"_id": "$status"}}])');
      expect(cmd.method).toBe('aggregate');
      expect(cmd.args).toEqual([[{ $group: { _id: '$status' } }]]);
    });

    it('解析 countDocuments', () => {
      const cmd = parseMongoQuery('db.users.countDocuments({})');
      expect(cmd.method).toBe('countDocuments');
      expect(cmd.args).toEqual([{}]);
    });

    it('解析无参数的 countDocuments', () => {
      const cmd = parseMongoQuery('db.users.countDocuments()');
      expect(cmd.method).toBe('countDocuments');
      expect(cmd.args).toEqual([]);
    });

    it('允许末尾分号', () => {
      const cmd = parseMongoQuery('db.users.find({});');
      expect(cmd.collection).toBe('users');
      expect(cmd.method).toBe('find');
    });

    it('允许首尾空白', () => {
      const cmd = parseMongoQuery('  db.users.find({})  ');
      expect(cmd.collection).toBe('users');
    });

    it('collection 名包含下划线和 $', () => {
      const cmd = parseMongoQuery('db.$my_collection.find({})');
      expect(cmd.collection).toBe('$my_collection');
    });

    it('collection 名含 . 和 - (合法 Mongo 命名) — M3', () => {
      const cmd = parseMongoQuery('db.my-app.events.deleteOne({"_id": "x"})');
      expect(cmd.collection).toBe('my-app.events');
      expect(cmd.method).toBe('deleteOne');
      expect(cmd.args).toEqual([{ _id: 'x' }]);
    });

    it('参数里含 .word( 的字符串值不破坏 collection/method 切分 (review round2 #1)', () => {
      const cmd = parseMongoQuery('db.coll.find({"url": "a.b(c)"})');
      expect(cmd.collection).toBe('coll');
      expect(cmd.method).toBe('find');
      expect(cmd.args).toEqual([{ url: 'a.b(c)' }]);
    });
  });

  describe('异常', () => {
    it('空字符串', () => {
      expect(() => parseMongoQuery('')).toThrow('Empty query');
    });

    it('非 db. 开头', () => {
      expect(() => parseMongoQuery('SELECT * FROM users')).toThrow('Invalid mongo query syntax');
    });

    it('不支持的 method', () => {
      expect(() => parseMongoQuery('db.users.drop()')).toThrow('Unsupported method: drop');
    });

    it('无效 JSON 参数', () => {
      expect(() => parseMongoQuery('db.users.find({invalid})')).toThrow('Failed to parse arguments');
    });

    it('缺少括号', () => {
      expect(() => parseMongoQuery('db.users.find')).toThrow('Invalid mongo query syntax');
    });
  });
});
