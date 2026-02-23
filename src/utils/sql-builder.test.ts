import { describe, it, expect } from 'vitest';
import {
  buildSelect,
  buildCount,
  buildInsert,
  buildUpdate,
  buildDelete,
} from './sql-builder';

describe('sql-builder', () => {
  describe('buildSelect', () => {
    it('MySQL 应该使用 ? 占位符', () => {
      const result = buildSelect('mysql', 'users', 10, 20);
      expect(result.sql).toBe('SELECT * FROM `users` LIMIT ? OFFSET ?');
      expect(result.params).toEqual([20, 10]);
    });

    it('PostgreSQL 应该使用 $N 占位符', () => {
      const result = buildSelect('postgresql', 'users', 10, 20);
      expect(result.sql).toBe('SELECT * FROM "users" LIMIT $1 OFFSET $2');
      expect(result.params).toEqual([20, 10]);
    });

    it('MySQL 应该支持 qualified table name (database.table)', () => {
      const result = buildSelect('mysql', 'users', 0, 50, 'mydb');
      expect(result.sql).toBe('SELECT * FROM `mydb`.`users` LIMIT ? OFFSET ?');
      expect(result.params).toEqual([50, 0]);
    });

    it('PostgreSQL 不应该使用 qualified name', () => {
      const result = buildSelect('postgresql', 'users', 0, 50, 'mydb');
      expect(result.sql).toBe('SELECT * FROM "users" LIMIT $1 OFFSET $2');
      expect(result.params).toEqual([50, 0]);
    });

    it('应该正确 escape identifier 中的反引号 (MySQL)', () => {
      const result = buildSelect('mysql', 'user`table', 0, 10);
      expect(result.sql).toBe('SELECT * FROM `user``table` LIMIT ? OFFSET ?');
    });

    it('应该支持边界条件: offset=0, limit=1', () => {
      const result = buildSelect('mysql', 'users', 0, 1);
      expect(result.params).toEqual([1, 0]);
    });
  });

  describe('buildCount', () => {
    it('MySQL 应该生成 COUNT 查询', () => {
      const result = buildCount('mysql', 'users');
      expect(result.sql).toBe('SELECT COUNT(*) as count FROM `users`');
      expect(result.params).toEqual([]);
    });

    it('PostgreSQL 应该生成 COUNT 查询', () => {
      const result = buildCount('postgresql', 'users');
      expect(result.sql).toBe('SELECT COUNT(*) as count FROM "users"');
      expect(result.params).toEqual([]);
    });

    it('MySQL 应该支持 qualified name', () => {
      const result = buildCount('mysql', 'users', 'testdb');
      expect(result.sql).toBe('SELECT COUNT(*) as count FROM `testdb`.`users`');
    });

    it('应该防护表名中的反引号 (MySQL)', () => {
      const result = buildCount('mysql', 'table`name');
      expect(result.sql).toBe('SELECT COUNT(*) as count FROM `table``name`');
    });
  });

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

    it('应该处理空对象 (边界条件)', () => {
      const row = {};
      const result = buildInsert('mysql', 'users', row);
      expect(result.sql).toBe('INSERT INTO `users` () VALUES ()');
      expect(result.params).toEqual([]);
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

    it('应该处理边界条件: 空 changes', () => {
      const pk = { id: 1 };
      const changes = {};
      const result = buildUpdate('mysql', 'users', pk, changes);
      expect(result.sql).toBe('UPDATE `users` SET  WHERE `id` = ?');
      expect(result.params).toEqual([1]);
    });
  });

  describe('buildDelete', () => {
    it('MySQL 应该生成正确的 DELETE 语句', () => {
      const pk = { id: 1 };
      const result = buildDelete('mysql', 'users', pk);
      expect(result.sql).toBe('DELETE FROM `users` WHERE `id` = ?');
      expect(result.params).toEqual([1]);
    });

    it('PostgreSQL 应该使用 $N 占位符', () => {
      const pk = { id: 1 };
      const result = buildDelete('postgresql', 'users', pk);
      expect(result.sql).toBe('DELETE FROM "users" WHERE "id" = $1');
      expect(result.params).toEqual([1]);
    });

    it('应该支持多主键', () => {
      const pk = { user_id: 10, tenant_id: 20 };
      const result = buildDelete('mysql', 'users', pk);
      expect(result.sql).toBe(
        'DELETE FROM `users` WHERE `user_id` = ? AND `tenant_id` = ?'
      );
      expect(result.params).toEqual([10, 20]);
    });

    it('应该支持 qualified table name', () => {
      const pk = { id: 1 };
      const result = buildDelete('mysql', 'users', pk, 'mydb');
      expect(result.sql).toBe('DELETE FROM `mydb`.`users` WHERE `id` = ?');
    });

    it('应该正确 escape identifier 中的反引号 (MySQL)', () => {
      const pk = { 'id`key': 1 };
      const result = buildDelete('mysql', 'user`table', pk);
      expect(result.sql).toBe('DELETE FROM `user``table` WHERE `id``key` = ?');
    });
  });

  describe('SQL Injection 防护', () => {
    it('identifier escape 应该防止注入攻击 (MySQL 反引号)', () => {
      // 尝试注入: table`; DROP TABLE users; --
      const maliciousTable = 'table`; DROP TABLE users; --';
      const result = buildCount('mysql', maliciousTable);
      // 所有反引号都应该被 escape
      expect(result.sql).toBe(
        'SELECT COUNT(*) as count FROM `table``; DROP TABLE users; --`'
      );
      expect(result.params).toEqual([]);
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
      const result = buildCount('mysql', 'table`with`backticks');
      expect(result.sql).toBe('SELECT COUNT(*) as count FROM `table``with``backticks`');
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
