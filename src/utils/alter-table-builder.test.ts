import { describe, it, expect } from 'vitest';
import { buildAlterTableStatements } from './alter-table-builder';
import type { AlterTableChanges, ModifyColumnDef } from '../types/query.js';

function emptyChanges(overrides?: Partial<AlterTableChanges>): AlterTableChanges {
  return {
    addedColumns: [],
    droppedColumns: [],
    modifiedColumns: [],
    renamedColumns: [],
    ...overrides,
  };
}

// 改动后的完整列: 原列 base (默认 int NULL, 无默认值 / 注释 / extra) 合并 edits, changed 即 edits 的键
function mod(name: string, edits: Partial<ModifyColumnDef>, base: Partial<ModifyColumnDef> = {}): ModifyColumnDef {
  return {
    name, dataType: 'int', nullable: true, defaultValue: null, comment: '', extra: '',
    ...base, ...edits, changed: Object.keys(edits) as ModifyColumnDef['changed'],
  };
}

describe('buildAlterTableStatements', () => {
  describe('MySQL', () => {
    const driver = 'mysql';

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
      it('改类型: 未改动的 NOT NULL / DEFAULT / AUTO_INCREMENT / COMMENT 原样写回', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('id', { dataType: 'bigint' }, { nullable: false, extra: 'auto_increment', comment: '主键' })],
        });
        expect(buildAlterTableStatements(driver, 'users', changes)).toEqual([
          "ALTER TABLE `users` MODIFY COLUMN `id` bigint NOT NULL auto_increment COMMENT '主键';",
        ]);
      });

      it('只改注释: 仍是完整定义 (不会生成 MODIFY COLUMN c COMMENT ...)', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('status', { comment: '状态' }, { dataType: 'varchar(16)', nullable: false, defaultValue: 'active' })],
        });
        expect(buildAlterTableStatements(driver, 'users', changes)).toEqual([
          "ALTER TABLE `users` MODIFY COLUMN `status` varchar(16) NOT NULL DEFAULT 'active' COMMENT '状态';",
        ]);
      });

      it('CURRENT_TIMESTAMP 默认值与 on update 保留, DEFAULT_GENERATED 元信息去掉', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('updated_at', { nullable: false }, {
            dataType: 'datetime(3)', defaultValue: 'CURRENT_TIMESTAMP(3)', extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)',
          })],
        });
        expect(buildAlterTableStatements(driver, 'users', changes)).toEqual([
          'ALTER TABLE `users` MODIFY COLUMN `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) on update CURRENT_TIMESTAMP(3);',
        ]);
      });

      it('未改动的表达式默认值 (DEFAULT_GENERATED) 加括号写回; 改过的默认值按输入处理', () => {
        const kept = emptyChanges({
          modifiedColumns: [mod('uid', { comment: 'x' }, { dataType: 'varchar(36)', defaultValue: 'uuid()', extra: 'DEFAULT_GENERATED' })],
        });
        expect(buildAlterTableStatements(driver, 't', kept)[0]).toBe(
          "ALTER TABLE `t` MODIFY COLUMN `uid` varchar(36) NULL DEFAULT (uuid()) COMMENT 'x';"
        );
        const edited = emptyChanges({
          modifiedColumns: [mod('uid', { defaultValue: 'none' }, { dataType: 'varchar(36)', extra: 'DEFAULT_GENERATED' })],
        });
        expect(buildAlterTableStatements(driver, 't', edited)[0]).toBe(
          "ALTER TABLE `t` MODIFY COLUMN `uid` varchar(36) NULL DEFAULT 'none';"
        );
      });

      it('原列 collation 写回 (不写会回落到表默认); 改成非字符串类型或类型自带 COLLATE 时不写', () => {
        const base = { dataType: 'varchar(64)', nullable: false, collation: 'utf8mb4_bin' };
        const stmts = buildAlterTableStatements(driver, 't', emptyChanges({
          modifiedColumns: [
            mod('code', { comment: '编码' }, base),
            mod('code', { dataType: 'varchar(128)' }, base),
            mod('code', { dataType: 'int' }, base),
            mod('code', { dataType: 'varchar(64) COLLATE utf8mb4_general_ci' }, base),
          ],
        }));
        expect(stmts).toEqual([
          "ALTER TABLE `t` MODIFY COLUMN `code` varchar(64) COLLATE utf8mb4_bin NOT NULL COMMENT '编码';",
          'ALTER TABLE `t` MODIFY COLUMN `code` varchar(128) COLLATE utf8mb4_bin NOT NULL;',
          'ALTER TABLE `t` MODIFY COLUMN `code` int NOT NULL;',
          'ALTER TABLE `t` MODIFY COLUMN `code` varchar(64) COLLATE utf8mb4_general_ci NOT NULL;',
        ]);
      });

      it('未改动的表达式默认值: information_schema 里转义过的引号还原', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('tags', { comment: 'x' }, { dataType: 'json', defaultValue: "_utf8mb4\\'[]\\'", extra: 'DEFAULT_GENERATED' })],
        });
        expect(buildAlterTableStatements(driver, 't', changes)[0]).toBe(
          "ALTER TABLE `t` MODIFY COLUMN `tags` json NULL DEFAULT (_utf8mb4'[]') COMMENT 'x';"
        );
      });

      it('默认值清空 (null) 时不写 DEFAULT: NOT NULL 列不会得到非法的 DEFAULT NULL', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('code', { defaultValue: null }, { dataType: 'varchar(8)', nullable: false, defaultValue: '' })],
        });
        expect(buildAlterTableStatements(driver, 't', changes)[0]).toBe('ALTER TABLE `t` MODIFY COLUMN `code` varchar(8) NOT NULL;');
      });

      it('字符串默认值与注释里的反斜杠和单引号都转义; 带前导零的数字串加引号', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('p', { comment: "C:\\dir 'x'" }, { dataType: 'varchar(8)', defaultValue: "a\\b'c" }),
            mod('code', { nullable: false }, { dataType: 'varchar(3)', defaultValue: '007' })],
        });
        expect(buildAlterTableStatements(driver, 't', changes)).toEqual([
          "ALTER TABLE `t` MODIFY COLUMN `p` varchar(8) NULL DEFAULT 'a\\\\b''c' COMMENT 'C:\\\\dir ''x''';",
          "ALTER TABLE `t` MODIFY COLUMN `code` varchar(3) NOT NULL DEFAULT '007';",
        ]);
      });

      it('位串默认值 (b\'0\') 不加引号', () => {
        const changes = emptyChanges({ modifiedColumns: [mod('flag', { comment: 'f' }, { dataType: 'bit(1)', defaultValue: "b'0'" })] });
        expect(buildAlterTableStatements(driver, 't', changes)[0]).toBe("ALTER TABLE `t` MODIFY COLUMN `flag` bit(1) NULL DEFAULT b'0' COMMENT 'f';");
      });

      it('无变更属性时不生成语句', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('age', {})],
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
          modifiedColumns: [mod('age', { dataType: 'bigint' })],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "age" TYPE bigint;',
        ]);
      });

      it('nullable=true 生成 DROP NOT NULL', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('email', { nullable: true })],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;',
        ]);
      });

      it('nullable=false 生成 SET NOT NULL', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('email', { nullable: false })],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;',
        ]);
      });

      it('defaultValue=null 生成 DROP DEFAULT', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('status', { defaultValue: null })],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;',
        ]);
      });

      it('defaultValue 非 null 生成 SET DEFAULT', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('status', { defaultValue: 'active' })],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          "ALTER TABLE \"users\" ALTER COLUMN \"status\" SET DEFAULT 'active';",
        ]);
      });

      it('defaultValue 数值不带引号', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('age', { defaultValue: '18' })],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          'ALTER TABLE "users" ALTER COLUMN "age" SET DEFAULT 18;',
        ]);
      });

      it('修改 comment 生成 COMMENT ON', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('email', { comment: '新注释' })],
        });
        const stmts = buildAlterTableStatements(driver, 'users', changes);
        expect(stmts).toEqual([
          "COMMENT ON COLUMN \"users\".\"email\" IS '新注释';",
        ]);
      });

      it('多个属性生成多条独立语句', () => {
        const changes = emptyChanges({
          modifiedColumns: [mod('age', {
            dataType: 'bigint',
            nullable: false,
            defaultValue: '0',
            comment: '年龄',
          })],
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
        modifiedColumns: [mod('ts', { defaultValue: 'now()' })],
      }));
      expect(mysqlStmts[0]).toContain('DEFAULT now()');
      expect(mysqlStmts[0]).not.toContain("'now()'");

      const pgStmts = buildAlterTableStatements('postgresql', 'tbl', emptyChanges({
        modifiedColumns: [mod('uid', { defaultValue: 'gen_random_uuid()' })],
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
