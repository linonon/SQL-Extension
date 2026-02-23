import { describe, it, expect } from 'vitest';
import { formatSql, formatMongoQuery } from './format-sql';

describe('formatMongoQuery', () => {
  describe('单行: 短查询保持单行', () => {
    it('find 空 filter', () => {
      expect(formatMongoQuery('db.users.find({})')).toBe('db.users.find({})');
    });

    it('countDocuments 无参数', () => {
      expect(formatMongoQuery('db.users.countDocuments()')).toBe('db.users.countDocuments()');
    });

    it('countDocuments 空 filter', () => {
      expect(formatMongoQuery('db.users.countDocuments({})')).toBe('db.users.countDocuments({})');
    });

    it('find 短 filter', () => {
      expect(formatMongoQuery('db.users.find({"name": "Alice"})')).toBe(
        'db.users.find({"name":"Alice"})'
      );
    });

    it('deleteOne 短 filter', () => {
      expect(formatMongoQuery('db.users.deleteOne({"_id": "abc"})')).toBe(
        'db.users.deleteOne({"_id":"abc"})'
      );
    });

    it('insertOne 短 doc', () => {
      expect(formatMongoQuery('db.users.insertOne({"name": "Bob"})')).toBe(
        'db.users.insertOne({"name":"Bob"})'
      );
    });
  });

  describe('多行: 长查询格式化换行', () => {
    it('find 长 filter 换行并缩进', () => {
      const input = 'db.users.find({"name":"Alice","email":"alice@example.com","status":"active","role":"admin"})';
      const result = formatMongoQuery(input);
      const lines = result.split('\n');
      // 第一行: db.users.find(
      expect(lines[0]).toBe('db.users.find(');
      // 中间: 2 格缩进的 JSON
      expect(lines[1]).toBe('  {');
      // 最后一行: )
      expect(lines[lines.length - 1]).toBe(')');
    });

    it('updateOne 多参数换行, 每个 arg 独立缩进', () => {
      const input = 'db.users.updateOne({"_id":"507f1f77bcf86cd799439011"},{"$set":{"name":"Updated Name","email":"new@example.com"}})';
      const result = formatMongoQuery(input);
      const lines = result.split('\n');
      expect(lines[0]).toBe('db.users.updateOne(');
      expect(lines[lines.length - 1]).toBe(')');
      // 两个 arg 之间有逗号分隔
      expect(result).toContain('},\n  {');
    });

    it('aggregate pipeline 换行', () => {
      const input = 'db.orders.aggregate([{"$match":{"status":"active"}},{"$group":{"_id":"$category","total":{"$sum":"$amount"}}}])';
      const result = formatMongoQuery(input);
      expect(result.startsWith('db.orders.aggregate(')).toBe(true);
      expect(result.endsWith(')')).toBe(true);
      // pipeline 数组应该被缩进
      expect(result).toContain('  [');
    });
  });

  describe('边界情况', () => {
    it('非 mongo 语法原样返回', () => {
      const sql = 'SELECT * FROM users';
      expect(formatMongoQuery(sql)).toBe(sql);
    });

    it('空字符串原样返回', () => {
      expect(formatMongoQuery('')).toBe('');
    });

    it('末尾分号被移除', () => {
      expect(formatMongoQuery('db.users.find({});')).toBe('db.users.find({})');
    });

    it('首尾空白被清理', () => {
      expect(formatMongoQuery('  db.users.find({})  ')).toBe('db.users.find({})');
    });

    it('collection 名含 $ 和下划线', () => {
      expect(formatMongoQuery('db.$my_collection.find({})')).toBe('db.$my_collection.find({})');
    });

    it('无效 JSON 参数原样返回', () => {
      const input = 'db.users.find({invalid})';
      expect(formatMongoQuery(input)).toBe(input);
    });

    it('已格式化的多行输入, 再格式化结果一致 (幂等)', () => {
      const input = 'db.users.find({"name":"Alice","email":"alice@example.com","status":"active","role":"admin"})';
      const first = formatMongoQuery(input);
      const second = formatMongoQuery(first);
      expect(second).toBe(first);
    });

    it('args 含字符串中的括号不影响解析', () => {
      expect(formatMongoQuery('db.users.find({"msg":"hello (world)"})')).toBe(
        'db.users.find({"msg":"hello (world)"})'
      );
    });

    it('args 含字符串中的右括号不影响解析', () => {
      expect(formatMongoQuery('db.users.find({"msg":"a) b"})')).toBe(
        'db.users.find({"msg":"a) b"})'
      );
    });

    it('嵌套对象正确格式化', () => {
      const input = 'db.users.find({"address":{"city":"NYC","zip":"10001"},"name":"Alice","age":30,"tags":["a","b","c"]})';
      const result = formatMongoQuery(input);
      // 长度超 80, 应该多行
      expect(result).toContain('\n');
      expect(result.startsWith('db.users.find(')).toBe(true);
      // 重新解析应该等价
      const reparsed = formatMongoQuery(result);
      expect(reparsed).toBe(result);
    });
  });

  describe('sql-builder 生成的查询', () => {
    it('buildSelect: aggregate skip+limit', () => {
      const input = 'db.users.aggregate([{"$skip":0},{"$limit":50}])';
      expect(formatMongoQuery(input)).toBe(
        'db.users.aggregate([{"$skip":0},{"$limit":50}])'
      );
    });

    it('buildCount: countDocuments', () => {
      expect(formatMongoQuery('db.users.countDocuments({})')).toBe(
        'db.users.countDocuments({})'
      );
    });

    it('buildInsert: insertOne', () => {
      expect(formatMongoQuery('db.users.insertOne({"name":"Bob"})')).toBe(
        'db.users.insertOne({"name":"Bob"})'
      );
    });

    it('buildUpdate: updateOne', () => {
      const input = 'db.users.updateOne({"_id":"x"},{"$set":{"name":"New"}})';
      expect(formatMongoQuery(input)).toBe(
        'db.users.updateOne({"_id":"x"}, {"$set":{"name":"New"}})'
      );
    });

    it('buildDelete: deleteOne', () => {
      expect(formatMongoQuery('db.users.deleteOne({"_id":"x"})')).toBe(
        'db.users.deleteOne({"_id":"x"})'
      );
    });

    it('buildSelectSql with sort: aggregate sort+limit', () => {
      const input = 'db.users.aggregate([{"$sort":{"name":1}},{"$limit":50}])';
      expect(formatMongoQuery(input)).toBe(
        'db.users.aggregate([{"$sort":{"name":1}},{"$limit":50}])'
      );
    });
  });
});

describe('formatSql with mongodb driverType', () => {
  it('mongodb 走 formatMongoQuery', () => {
    expect(formatSql('db.users.find({})', 'mongodb')).toBe('db.users.find({})');
  });

  it('mysql 走 sql-formatter', () => {
    const result = formatSql('select * from users', 'mysql');
    expect(result).toContain('SELECT');
  });
});
