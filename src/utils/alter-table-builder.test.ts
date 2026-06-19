import { describe, it, expect } from 'vitest';
import { buildAlterTableStatements } from './alter-table-builder';
import type { AlterTableChanges } from '../types/query.js';

function emptyChanges(overrides?: Partial<AlterTableChanges>): AlterTableChanges {
  return {
    addedColumns: [],
    droppedColumns: [],
    modifiedColumns: [],
    renamedColumns: [],
    ...overrides,
  };
}

describe('buildAlterTableStatements', () => {
  describe('MySQL', () => {
    const driver = 'mysql';

    describe('rename table', () => {
      it('应该生成 RENAME TO 语句', () => {
        const changes = emptyChanges({ renamedTable: 'new_users' });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual(['ALTER TABLE `users` RENAME TO `new_users`;']);
      });

      it('rename 后续操作应该使用新表名', () => {
        const changes = emptyChanges({
          renamedTable: 'new_users',
          droppedColumns: ['age'],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toBe('ALTER TABLE `users` RENAME TO `new_users`;');
        expect(stmts[1]).toBe('ALTER TABLE `new_users` DROP COLUMN `age`;');
      });
    });

    describe('add column', () => {
      it('基础 add column: 仅 name + dataType', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'email', dataType: 'varchar(255)', nullable: true, defaultValue: null, comment: '' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE `users` ADD COLUMN `email` varchar(255);',
        ]);
      });

      it('NOT NULL 约束', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'email', dataType: 'varchar(255)', nullable: false, defaultValue: null, comment: '' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain('NOT NULL');
      });

      it('带 defaultValue 字符串', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'status', dataType: 'varchar(20)', nullable: true, defaultValue: 'active', comment: '' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain("DEFAULT 'active'");
      });

      it('带 defaultValue 数值', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'age', dataType: 'int', nullable: true, defaultValue: '0', comment: '' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain('DEFAULT 0');
        expect(stmts[0]).not.toContain("'0'");
      });

      it('带 comment', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'email', dataType: 'varchar(255)', nullable: true, defaultValue: null, comment: '用户邮箱' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain("COMMENT '用户邮箱'");
      });

      it('comment 中的单引号应转义', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'note', dataType: 'text', nullable: true, defaultValue: null, comment: "it's a note" }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain("COMMENT 'it''s a note'");
      });

      it('所有属性组合', () => {
        const changes = emptyChanges({
          addedColumns: [{
            name: 'score',
            dataType: 'decimal(10,2)',
            nullable: false,
            defaultValue: '0.00',
            comment: '分数',
          }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toBe(
          "ALTER TABLE `users` ADD COLUMN `score` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '分数';"
        );
      });
    });

    describe('drop column', () => {
      it('应该生成 DROP COLUMN 语句', () => {
        const changes = emptyChanges({ droppedColumns: ['age', 'email'] });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE `users` DROP COLUMN `age`;',
          'ALTER TABLE `users` DROP COLUMN `email`;',
        ]);
      });
    });

    describe('rename column', () => {
      it('应该生成 RENAME COLUMN 语句', () => {
        const changes = emptyChanges({
          renamedColumns: [{ from: 'old_name', to: 'new_name' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE `users` RENAME COLUMN `old_name` TO `new_name`;',
        ]);
      });
    });

    describe('modify column', () => {
      it('修改 dataType', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'age', dataType: 'bigint' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE `users` MODIFY COLUMN `age` bigint;',
        ]);
      });

      it('修改 nullable', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'email', nullable: false }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain('NOT NULL');
      });

      it('修改 nullable 为 true', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'email', nullable: true }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain('NULL');
        expect(stmts[0]).not.toContain('NOT NULL');
      });

      it('defaultValue 为 null 时生成 DEFAULT NULL', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'status', defaultValue: null }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain('DEFAULT NULL');
      });

      it('defaultValue 为数值', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'age', defaultValue: '42' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain('DEFAULT 42');
      });

      it('defaultValue 为字符串', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'status', defaultValue: 'active' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain("DEFAULT 'active'");
      });

      it('修改 comment', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'email', comment: '新注释' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).toContain("COMMENT '新注释'");
      });

      it('多个属性合并到一条 MODIFY 语句', () => {
        const changes = emptyChanges({
          modifiedColumns: [{
            name: 'age',
            dataType: 'bigint',
            nullable: false,
            defaultValue: '0',
            comment: '年龄',
          }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toHaveLength(1);
        expect(stmts[0]).toBe(
          "ALTER TABLE `users` MODIFY COLUMN `age` bigint NOT NULL DEFAULT 0 COMMENT '年龄';"
        );
      });

      it('无变更属性时不生成语句', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'age' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([]);
      });
    });

    describe('空 changes', () => {
      it('应该返回空数组', () => {
        const stmts = buildAlterTableStatements(driver, 'users', emptyChanges());
        expect(stmts).toEqual([]);
      });
    });
  });

  describe('PostgreSQL', () => {
    const driver = 'postgresql';

    describe('rename table', () => {
      it('应该生成 RENAME TO 语句', () => {
        const changes = emptyChanges({ renamedTable: 'new_users' });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual(['ALTER TABLE "users" RENAME TO "new_users";']);
      });
    });

    describe('add column', () => {
      it('基础 add column', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'email', dataType: 'varchar(255)', nullable: true, defaultValue: null, comment: '' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ADD COLUMN "email" varchar(255);',
        ]);
      });

      it('带 comment 时生成独立的 COMMENT ON 语句', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'email', dataType: 'varchar(255)', nullable: true, defaultValue: null, comment: '用户邮箱' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toHaveLength(2);
        expect(stmts[0]).toBe('ALTER TABLE "users" ADD COLUMN "email" varchar(255);');
        expect(stmts[1]).toBe('COMMENT ON COLUMN "users"."email" IS \'用户邮箱\';');
      });

      it('ADD COLUMN 语句中不包含 COMMENT 关键字', () => {
        const changes = emptyChanges({
          addedColumns: [{ name: 'note', dataType: 'text', nullable: true, defaultValue: null, comment: 'test' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts[0]).not.toContain('COMMENT');
      });
    });

    describe('drop column', () => {
      it('应该生成 DROP COLUMN 语句', () => {
        const changes = emptyChanges({ droppedColumns: ['age'] });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual(['ALTER TABLE "users" DROP COLUMN "age";']);
      });
    });

    describe('rename column', () => {
      it('应该生成 RENAME COLUMN 语句', () => {
        const changes = emptyChanges({
          renamedColumns: [{ from: 'old_name', to: 'new_name' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" RENAME COLUMN "old_name" TO "new_name";',
        ]);
      });
    });

    describe('modify column', () => {
      it('修改 dataType 生成 ALTER COLUMN TYPE', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'age', dataType: 'bigint' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "age" TYPE bigint;',
        ]);
      });

      it('nullable=true 生成 DROP NOT NULL', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'email', nullable: true }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;',
        ]);
      });

      it('nullable=false 生成 SET NOT NULL', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'email', nullable: false }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;',
        ]);
      });

      it('defaultValue=null 生成 DROP DEFAULT', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'status', defaultValue: null }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;',
        ]);
      });

      it('defaultValue 非 null 生成 SET DEFAULT', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'status', defaultValue: 'active' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          "ALTER TABLE \"users\" ALTER COLUMN \"status\" SET DEFAULT 'active';",
        ]);
      });

      it('defaultValue 数值不带引号', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'age', defaultValue: '18' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "age" SET DEFAULT 18;',
        ]);
      });

      it('修改 comment 生成 COMMENT ON', () => {
        const changes = emptyChanges({
          modifiedColumns: [{ name: 'email', comment: '新注释' }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          "COMMENT ON COLUMN \"users\".\"email\" IS '新注释';",
        ]);
      });

      it('多个属性生成多条独立语句', () => {
        const changes = emptyChanges({
          modifiedColumns: [{
            name: 'age',
            dataType: 'bigint',
            nullable: false,
            defaultValue: '0',
            comment: '年龄',
          }],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toHaveLength(4);
        expect(stmts[0]).toBe('ALTER TABLE "users" ALTER COLUMN "age" TYPE bigint;');
        expect(stmts[1]).toBe('ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL;');
        expect(stmts[2]).toBe('ALTER TABLE "users" ALTER COLUMN "age" SET DEFAULT 0;');
        expect(stmts[3]).toBe("COMMENT ON COLUMN \"users\".\"age\" IS '年龄';");
      });
    });
  });

  describe('标识符转义', () => {
    it('MySQL: 含空格的表名/列名用反引号', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'first name', dataType: 'varchar(50)', nullable: true, defaultValue: null, comment: '' }],
      });
      const stmts = buildAlterTableStatements('mysql', 'my table', changes);
      expect(stmts[0]).toContain('`my table`');
      expect(stmts[0]).toContain('`first name`');
    });

    it('MySQL: 反引号转义', () => {
      const changes = emptyChanges({ droppedColumns: ['col`name'] });
      const stmts = buildAlterTableStatements('mysql', 'tbl`test', changes);
      expect(stmts[0]).toBe('ALTER TABLE `tbl``test` DROP COLUMN `col``name`;');
    });

    it('PostgreSQL: 含空格的名称用双引号', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'first name', dataType: 'varchar(50)', nullable: true, defaultValue: null, comment: '' }],
      });
      const stmts = buildAlterTableStatements('postgresql', 'my table', changes);
      expect(stmts[0]).toContain('"my table"');
      expect(stmts[0]).toContain('"first name"');
    });

    it('PostgreSQL: 双引号转义', () => {
      const changes = emptyChanges({ droppedColumns: ['col"name'] });
      const stmts = buildAlterTableStatements('postgresql', 'tbl"test', changes);
      expect(stmts[0]).toBe('ALTER TABLE "tbl""test" DROP COLUMN "col""name";');
    });
  });

  describe('buildDefaultClause (通过 add/modify 间接测试)', () => {
    it('null -> DEFAULT NULL', () => {
      const changes = emptyChanges({
        modifiedColumns: [{ name: 'col', defaultValue: null }],
      });
      const stmts = buildAlterTableStatements('mysql', 'tbl', changes);
      expect(stmts[0]).toContain('DEFAULT NULL');
    });

    it('数值不带引号: 整数', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'col', dataType: 'int', nullable: true, defaultValue: '42', comment: '' }],
      });
      const stmts = buildAlterTableStatements('mysql', 'tbl', changes);
      expect(stmts[0]).toContain('DEFAULT 42');
      expect(stmts[0]).not.toContain("'42'");
    });

    it('数值不带引号: 负数', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'col', dataType: 'int', nullable: true, defaultValue: '-1', comment: '' }],
      });
      const stmts = buildAlterTableStatements('mysql', 'tbl', changes);
      expect(stmts[0]).toContain('DEFAULT -1');
    });

    it('数值不带引号: 小数', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'col', dataType: 'decimal(10,2)', nullable: true, defaultValue: '3.14', comment: '' }],
      });
      const stmts = buildAlterTableStatements('mysql', 'tbl', changes);
      expect(stmts[0]).toContain('DEFAULT 3.14');
    });

    it('字符串带单引号', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'col', dataType: 'varchar(50)', nullable: true, defaultValue: 'hello', comment: '' }],
      });
      const stmts = buildAlterTableStatements('mysql', 'tbl', changes);
      expect(stmts[0]).toContain("DEFAULT 'hello'");
    });

    it('字符串中的单引号转义', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'col', dataType: 'varchar(50)', nullable: true, defaultValue: "it's", comment: '' }],
      });
      const stmts = buildAlterTableStatements('mysql', 'tbl', changes);
      expect(stmts[0]).toContain("DEFAULT 'it''s'");
    });

    it('CURRENT_TIMESTAMP 关键字不加引号 (表达式默认值, 非字面字符串)', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'created', dataType: 'datetime', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', comment: '' }],
      });
      const stmts = buildAlterTableStatements('mysql', 'tbl', changes);
      expect(stmts[0]).toContain('DEFAULT CURRENT_TIMESTAMP');
      expect(stmts[0]).not.toContain("'CURRENT_TIMESTAMP'");
    });

    it('函数调用默认值不加引号 (now() / gen_random_uuid())', () => {
      const mysqlStmts = buildAlterTableStatements('mysql', 'tbl', emptyChanges({
        modifiedColumns: [{ name: 'ts', defaultValue: 'now()' }],
      }));
      expect(mysqlStmts[0]).toContain('DEFAULT now()');
      expect(mysqlStmts[0]).not.toContain("'now()'");

      const pgStmts = buildAlterTableStatements('postgresql', 'tbl', emptyChanges({
        modifiedColumns: [{ name: 'uid', defaultValue: 'gen_random_uuid()' }],
      }));
      expect(pgStmts[0]).toContain('SET DEFAULT gen_random_uuid()');
      expect(pgStmts[0]).not.toContain("'gen_random_uuid()'");
    });

    it('普通字符串仍加引号 (不被误判为表达式)', () => {
      const changes = emptyChanges({
        addedColumns: [{ name: 'status', dataType: 'varchar(20)', nullable: true, defaultValue: 'active', comment: '' }],
      });
      const stmts = buildAlterTableStatements('mysql', 'tbl', changes);
      expect(stmts[0]).toContain("DEFAULT 'active'");
    });
  });
});
