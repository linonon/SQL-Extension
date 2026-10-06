import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DumpService } from './dump-service';
import { createMockDriver as createBaseMockDriver } from '../__mocks__/mock-driver';
import type { IDatabaseDriver } from '../types/driver';
import { splitSqlStatements } from '../utils/destructive-sql';

function createMockDriver(driverType: IDatabaseDriver['driverType'] = 'mysql'): IDatabaseDriver {
  const driver = createBaseMockDriver({ driverType });
  driver.getTableDDL.mockResolvedValue('CREATE TABLE `users` (`id` int PRIMARY KEY);');
  return driver;
}

describe('DumpService', () => {
  let service: DumpService;

  beforeEach(() => {
    service = new DumpService();
  });

  describe('dumpStruct', () => {
    it('MySQL 方言: 反引号 + DROP TABLE IF EXISTS', async () => {
      const driver = createMockDriver('mysql');
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE `users` (`id` int PRIMARY KEY);');

      const result = await service.dumpStruct(driver, 'testdb', 'users');

      expect(result).toContain('DROP TABLE IF EXISTS `users`;');
      expect(result).toContain('CREATE TABLE `users`');
      expect(result).toContain('-- Table: users');
      expect(result).toContain('-- Dump from SQL Extension');
    });

    it('PostgreSQL 方言: 双引号 + DROP TABLE IF EXISTS', async () => {
      const driver = createMockDriver('postgresql');
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE "users" ("id" serial PRIMARY KEY);');

      const result = await service.dumpStruct(driver, 'testdb', 'users');

      expect(result).toContain('DROP TABLE IF EXISTS "users";');
      expect(result).toContain('CREATE TABLE "users"');
    });

    it('MySQL 表名含反引号时正确转义', async () => {
      const driver = createMockDriver('mysql');
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE `my``table` (`id` int);');

      const result = await service.dumpStruct(driver, 'testdb', 'my`table');

      expect(result).toContain('DROP TABLE IF EXISTS `my``table`;');
    });

    it('PostgreSQL 表名含双引号时正确转义', async () => {
      const driver = createMockDriver('postgresql');
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE "my""table" ("id" serial);');

      const result = await service.dumpStruct(driver, 'testdb', 'my"table');

      expect(result).toContain('DROP TABLE IF EXISTS "my""table";');
    });
  });

  describe('dumpStructAndData', () => {
    it('表无数据时只返回 struct', async () => {
      const driver = createMockDriver('mysql');
      (driver.execute as any).mockResolvedValue({
        columns: [],
        rows: [{ cnt: 0 }],
        affectedRows: 0,
        executionTime: 0,
      });

      const result = await service.dumpStructAndData(driver, 'testdb', 'users');

      expect(result).toContain('DROP TABLE IF EXISTS');
      expect(result).not.toContain('INSERT INTO');
    });

    it('MySQL: 生成 INSERT 语句', async () => {
      const driver = createMockDriver('mysql');

      // 第一次 execute: COUNT
      // 第二次 execute: SELECT page 1
      // 第三次 execute: SELECT page 2 (空)
      (driver.execute as any)
        // MySQL bigNumberStrings 下 COUNT(*) 是字符串
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: '2' }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
          affectedRows: 0,
          executionTime: 0,
        })
        .mockResolvedValueOnce({ columns: [], rows: [], affectedRows: 0, executionTime: 0 });

      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
        { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      ]);

      const result = await service.dumpStructAndData(driver, 'testdb', 'users');

      expect(result).toContain('INSERT INTO `users`');
      expect(result).toContain('`id`');
      expect(result).toContain('`name`');
      expect(result).toContain("'Alice'");
      expect(result).toContain("'Bob'");
    });

    it('PostgreSQL: 生成 INSERT 语句用双引号', async () => {
      const driver = createMockDriver('postgresql');

      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: [{ id: 1, name: 'Alice' }],
          affectedRows: 0,
          executionTime: 0,
        });

      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
        { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      ]);
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE "users" ("id" serial PRIMARY KEY);');

      const result = await service.dumpStructAndData(driver, 'testdb', 'users');

      expect(result).toContain('INSERT INTO "users"');
      expect(result).toContain('"id"');
      expect(result).toContain('"name"');
    });

    it('onProgress 被调用', async () => {
      const driver = createMockDriver('mysql');
      const onProgress = vi.fn();

      (driver.execute as any)
        // MySQL bigNumberStrings 下 COUNT(*) 是字符串
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: '2' }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: [{ id: 1 }, { id: 2 }],
          affectedRows: 0,
          executionTime: 0,
        });

      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
      ]);

      await service.dumpStructAndData(driver, 'testdb', 'users', onProgress);

      expect(onProgress).toHaveBeenCalledWith(2, 2);
    });

    it('cancellationToken cancel 时中断', async () => {
      const driver = createMockDriver('mysql');
      const token = { isCancellationRequested: false };

      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 3000 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: Array.from({ length: 1000 }, (_, i) => ({ id: i })),
          affectedRows: 0,
          executionTime: 0,
        })
        .mockImplementation(() => {
          // 第二页时取消
          token.isCancellationRequested = true;
          return Promise.resolve({
            columns: [],
            rows: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1000 })),
            affectedRows: 0,
            executionTime: 0,
          });
        });

      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
      ]);

      // 取消抛错而不是交回半截 dump; 第三页不会请求 (count + 两页)
      await expect(service.dumpStructAndData(driver, 'testdb', 'users', undefined, token))
        .rejects.toThrow('Dump cancelled');
      expect((driver.execute as any).mock.calls.length).toBe(3);
    });

    it('一页按字节数拆成多条 INSERT, 每条不超过 1MB; 单行超限时自成一条', async () => {
      const driver = createMockDriver('mysql');
      // 多字节字符按 UTF-8 字节计: 300K 个 "中" 约 900KB
      const big = '中'.repeat(300_000);
      const rows = [{ id: 1, v: big }, { id: 2, v: big }, { id: 3, v: 'x'.repeat(2_000_000) }, { id: 4, v: 'a' }, { id: 5, v: 'b' }];
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: '5' }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows, affectedRows: 0, executionTime: 0 });
      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
        { name: 'v', dataType: 'longtext', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      ]);

      const sql = await service.dumpStructAndData(driver, 'testdb', 'users');
      const inserts = splitSqlStatements(sql, 'mysql').filter((s) => s.startsWith('INSERT'));

      expect(inserts.map((s) => (s.match(/^\(\d+, /gm) ?? []).map((m) => m.slice(1, -2)))).toEqual([['1'], ['2'], ['3'], ['4', '5']]);
      for (const s of inserts.filter((s) => !s.includes("(3, 'x"))) {
        expect(Buffer.byteLength(s)).toBeLessThanOrEqual(1024 * 1024 + 100);
      }
    });
  });

  describe('escapeValue (通过 dump 输出间接测试)', () => {
    let driver: IDatabaseDriver;

    beforeEach(() => {
      driver = createMockDriver('mysql');
      (driver.listColumns as any).mockResolvedValue([
        { name: 'val', dataType: 'text', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      ]);
    });

    it('null -> NULL', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: null }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain('(NULL)');
    });

    it('number -> 数字字符串不带引号', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: 42 }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain('(42)');
      // 确保不是 ('42')
      expect(result).not.toContain("('42')");
    });

    it('boolean -> TRUE / FALSE', async () => {
      (driver.execute as any)
        // MySQL bigNumberStrings 下 COUNT(*) 是字符串
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: '2' }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: [{ val: true }, { val: false }],
          affectedRows: 0,
          executionTime: 0,
        });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain('(TRUE)');
      expect(result).toContain('(FALSE)');
    });

    it('string -> 单引号包裹', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: 'hello' }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain("('hello')");
    });

    it("string 内部单引号转义为 ''", async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: "it's" }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain("('it''s')");
    });

    it('含反斜杠的字符串转义', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: 'path\\to\\file' }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain("('path\\\\to\\\\file')");
    });

    it('Date -> ISO 字符串带单引号', async () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: date }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain("('2024-01-15T10:30:00.000Z')");
    });

    it('undefined -> NULL', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: undefined }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain('(NULL)');
    });
  });
});

describe('dump / import 往返', () => {
  const columns = ['id', 's', 'p', 'n', 'z', 'b', 'j', 'o'].map((name) => ({
    name, dataType: 'x', nullable: true, isPrimaryKey: name === 'id', defaultValue: null, extra: '',
  }));
  const row = {
    id: 1,
    s: "it's",
    p: 'C:\\dir\\', // 以反斜杠结尾
    n: 'line1\nline2;', // 换行 + 分号
    z: null,
    b: Buffer.from([0x00, 0xff, 0x27]), // 二进制, 含引号字节
    j: '{"q":"it\'s","p":"a\\\\b"}', // JSON 列原文 (jsonStrings)
    o: { k: 1 }, // 对象值按 JSON 写出
  };

  async function dump(driverType: IDatabaseDriver['driverType'], ddl: string): Promise<{ sql: string; driver: IDatabaseDriver }> {
    const driver = createBaseMockDriver({ driverType });
    driver.getTableDDL.mockResolvedValue(ddl);
    driver.listColumns.mockResolvedValue(columns);
    driver.execute
      .mockResolvedValueOnce({ columns: [], rows: [{ cnt: '1' }], affectedRows: 0, executionTime: 0 })
      .mockResolvedValueOnce({ columns: [], rows: [row], affectedRows: 0, executionTime: 0 });
    return { sql: await new DumpService().dumpStructAndData(driver, 'db', 't'), driver };
  }

  it('MySQL: 反斜杠加倍, Buffer 为 X 字面量, 按主键分页, 能被 splitSqlStatements 切回原语句', async () => {
    // SHOW CREATE TABLE 不带结尾分号
    const ddl = 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB';
    const { sql, driver } = await dump('mysql', ddl);
    const insert = 'INSERT INTO `t` (`id`, `s`, `p`, `n`, `z`, `b`, `j`, `o`) VALUES\n'
      + "(1, 'it''s', 'C:\\\\dir\\\\', 'line1\nline2;', NULL, X'00ff27', '{\"q\":\"it''s\",\"p\":\"a\\\\\\\\b\"}', '{\"k\":1}')";

    const stmts = splitSqlStatements(sql, 'mysql');
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toMatch(/^-- Dump from SQL Extension[\s\S]*\nDROP TABLE IF EXISTS `t`$/);
    expect(stmts[1]).toBe(ddl);
    expect(stmts[2]).toBe(insert);
    expect(driver.execute).toHaveBeenLastCalledWith('SELECT * FROM `db`.`t` ORDER BY `id` LIMIT 1000 OFFSET 0', undefined, 'db');
  });

  it('PostgreSQL: 只双写单引号 (反斜杠原样), Buffer 为 bytea hex, 查询落到目标库', async () => {
    const { sql, driver } = await dump('postgresql', 'CREATE TABLE "t" (\n  "id" int4 NOT NULL\n);');
    expect(sql).toContain('INSERT INTO "t" ("id", "s", "p", "n", "z", "b", "j", "o") VALUES\n'
      + "(1, 'it''s', 'C:\\dir\\', 'line1\nline2;', NULL, '\\x00ff27'::bytea, '{\"q\":\"it''s\",\"p\":\"a\\\\b\"}', '{\"k\":1}');");
    expect(driver.execute).toHaveBeenLastCalledWith('SELECT * FROM "t" ORDER BY "id" LIMIT 1000 OFFSET 0', undefined, 'db');
  });

  it('PostgreSQL: 序列列在数据之后把序列推到 MAX, 只进不退', async () => {
    const driver = createBaseMockDriver({ driverType: 'postgresql' });
    driver.getTableDDL.mockResolvedValue('CREATE SEQUENCE IF NOT EXISTS "T_id_seq";\nCREATE TABLE "T" ("id" int4);');
    driver.listColumns.mockResolvedValue([
      { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true, defaultValue: "nextval('\"T_id_seq\"'::regclass)", extra: '' },
    ]);
    driver.execute
      .mockResolvedValueOnce({ columns: [], rows: [{ cnt: '1' }], affectedRows: 0, executionTime: 0 })
      .mockResolvedValueOnce({ columns: [], rows: [{ id: 7 }], affectedRows: 0, executionTime: 0 });

    const sql = await new DumpService().dumpStructAndData(driver, 'db', 'T');

    expect(sql.trimEnd()).toMatch(/INSERT INTO "T" \("id"\) VALUES\n\(7\);\n\nSELECT setval\('"T_id_seq"', GREATEST\(MAX\("id"\), \(SELECT last_value FROM "T_id_seq"\)\)\) FROM "T";$/);
  });
});
