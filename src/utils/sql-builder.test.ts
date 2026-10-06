import { describe, it, expect } from 'vitest';
import {
  escapeIdentifier,
  buildInsert,
  buildUpdate,
  buildBatchDelete,
} from './sql-builder';

describe('sql-builder', () => {
  describe('buildInsert', () => {
    it('MySQL 应该生成正确的 INSERT 语句', () => {
      const row = { name: 'Alice', age: 30 };
      const result = buildInsert('mysql', 'users', row);
      expect(result.sql).toBe('INSERT INTO `users` (`name`, `age`) VALUES (?, ?)');
      expect(result.params).toEqual(['Alice', 30]);
    });

    it('PostgreSQL 应该使用 $N 占位符', () => {
      const row = { name: 'Bob', age: 25 };
      const result = buildInsert('postgresql', 'users', row);
      expect(result.sql).toBe('INSERT INTO "users" ("name", "age") VALUES ($1, $2)');
      expect(result.params).toEqual(['Bob', 25]);
    });

    it('应该支持 qualified table name', () => {
      const row = { name: 'Charlie' };
      const result = buildInsert('mysql', 'users', row, 'mydb');
      expect(result.sql).toBe('INSERT INTO `mydb`.`users` (`name`) VALUES (?)');
      expect(result.params).toEqual(['Charlie']);
    });

    it('应该正确 escape column name 中的反引号 (MySQL)', () => {
      const row = { 'user`name': 'Alice' };
      const result = buildInsert('mysql', 'users', row);
      expect(result.sql).toContain('`user``name`');
    });

    it('空 row 生成插入全默认值的合法 SQL (所有列由 DB 填充)', () => {
      // MySQL: () VALUES (); PG: DEFAULT VALUES. 不拼非法 SQL 也不误抛
      expect(buildInsert('mysql', 'users', {}).sql).toBe('INSERT INTO `users` () VALUES ()');
      expect(buildInsert('postgresql', 'users', {}).sql).toBe('INSERT INTO "users" DEFAULT VALUES');
    });

    it('应该处理特殊值: null, undefined, 空字符串', () => {
      const row = { a: null, b: undefined, c: '' };
      const result = buildInsert('mysql', 'users', row);
      expect(result.params).toEqual([null, undefined, '']);
    });
  });

  describe('buildUpdate', () => {
    it('MySQL 应该生成正确的 UPDATE 语句', () => {
      const pk = { id: 1 };
      const changes = { name: 'Alice', age: 31 };
      const result = buildUpdate('mysql', 'users', pk, changes);
      expect(result.sql).toBe('UPDATE `users` SET `name` = ?, `age` = ? WHERE `id` = ?');
      expect(result.params).toEqual(['Alice', 31, 1]);
    });

    it('PostgreSQL 应该使用递增的 $N 占位符', () => {
      const pk = { id: 1 };
      const changes = { name: 'Bob' };
      const result = buildUpdate('postgresql', 'users', pk, changes);
      expect(result.sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2');
      expect(result.params).toEqual(['Bob', 1]);
    });

    it('应该支持多主键 WHERE 子句', () => {
      const pk = { user_id: 10, tenant_id: 20 };
      const changes = { status: 'active' };
      const result = buildUpdate('mysql', 'users', pk, changes);
      expect(result.sql).toBe(
        'UPDATE `users` SET `status` = ? WHERE `user_id` = ? AND `tenant_id` = ?'
      );
      expect(result.params).toEqual(['active', 10, 20]);
    });

    it('应该支持 qualified table name', () => {
      const pk = { id: 1 };
      const changes = { name: 'Alice' };
      const result = buildUpdate('mysql', 'users', pk, changes, 'mydb');
      expect(result.sql).toContain('`mydb`.`users`');
    });

    it('应该正确 escape column name 中的反引号 (MySQL)', () => {
      const pk = { 'id`pk': 1 };
      const changes = { 'name`col': 'test' };
      const result = buildUpdate('mysql', 'users', pk, changes);
      expect(result.sql).toContain('`name``col`');
      expect(result.sql).toContain('`id``pk`');
    });

    it('空 changes 应该 fail-fast 抛错而非生成非法 SQL', () => {
      expect(() => buildUpdate('mysql', 'users', { id: 1 }, {})).toThrow(/no changes/i);
    });

    it('空 primaryKeys 应该拒绝生成无 WHERE 的 UPDATE (防误改全表)', () => {
      // 任何 caller 漏拦空 pk 都要在 builder 边界立即抛错, 而非生成残缺/危险 SQL
      expect(() => buildUpdate('mysql', 'users', {}, { name: 'x' })).toThrow(/without.*where|primary key/i);
    });
  });

  describe('buildBatchDelete', () => {
    it('空列表返回空 SQL (no-op)', () => {
      const result = buildBatchDelete('mysql', 'users', []);
      expect(result.sql).toBe('');
      expect(result.params).toEqual([]);
    });

    it('单主键应直接生成 IN 列表 (不做字符串切片)', () => {
      const result = buildBatchDelete('mysql', 'users', [{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(result.sql).toBe('DELETE FROM `users` WHERE `id` IN (?, ?, ?)');
      expect(result.params).toEqual([1, 2, 3]);
    });

    it('复合主键生成 tuple IN', () => {
      const result = buildBatchDelete('mysql', 'm', [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ]);
      expect(result.sql).toBe('DELETE FROM `m` WHERE (`a`, `b`) IN ((?, ?), (?, ?))');
      expect(result.params).toEqual([1, 2, 3, 4]);
    });

    it('PostgreSQL 单主键用 $N 占位符', () => {
      const result = buildBatchDelete('postgresql', 'users', [{ id: 7 }, { id: 8 }]);
      expect(result.sql).toBe('DELETE FROM "users" WHERE "id" IN ($1, $2)');
      expect(result.params).toEqual([7, 8]);
    });

    it('条目主键键集不一致应 fail-fast (防参数错位误删)', () => {
      expect(() =>
        buildBatchDelete('mysql', 'm', [{ a: 1, b: 2 }, { a: 3 }]),
      ).toThrow(/key/i);
    });

    it('同一组复合主键键顺序不同不应误判为不一致', () => {
      // {a,b} 与 {b,a} 是同一键集, 不同插入顺序; 取值按 keys[0] 名字索引故仍正确
      const result = buildBatchDelete('mysql', 'm', [
        { a: 1, b: 2 },
        { b: 4, a: 3 },
      ]);
      expect(result.sql).toBe('DELETE FROM `m` WHERE (`a`, `b`) IN ((?, ?), (?, ?))');
      expect(result.params).toEqual([1, 2, 3, 4]);
    });

    it('空主键对象应拒绝 (防无 WHERE 误删全表)', () => {
      expect(() => buildBatchDelete('mysql', 'users', [{}])).toThrow(/without.*where|primary key/i);
    });
  });

  describe('SQL Injection 防护', () => {
    it('identifier escape 应该防止注入攻击 (MySQL 反引号)', () => {
      // 尝试注入: table`; DROP TABLE users; --
      const maliciousTable = 'table`; DROP TABLE users; --';
      // 所有反引号都应该被 escape
      expect(escapeIdentifier('mysql', maliciousTable)).toBe('`table``; DROP TABLE users; --`');
    });

    it('参数化查询应该防止值注入', () => {
      const maliciousRow = { name: "'; DROP TABLE users; --" };
      const result = buildInsert('mysql', 'users', maliciousRow);
      // 值应该在 params 中, 不直接拼接到 SQL
      expect(result.sql).toBe('INSERT INTO `users` (`name`) VALUES (?)');
      expect(result.params).toEqual(["'; DROP TABLE users; --"]);
    });
  });

  describe('特殊字符处理', () => {
    it('应该处理反引号 (MySQL identifier)', () => {
      expect(escapeIdentifier('mysql', 'table`with`backticks')).toBe('`table``with``backticks`');
    });

    it('应该处理单引号', () => {
      const row = { name: "O'Brien" };
      const result = buildInsert('mysql', 'users', row);
      expect(result.params).toEqual(["O'Brien"]);
    });

    it('应该处理换行符和特殊字符', () => {
      const row = { comment: 'Line1\nLine2\tTabbed' };
      const result = buildInsert('postgresql', 'comments', row);
      expect(result.params).toEqual(['Line1\nLine2\tTabbed']);
    });
  });
});
