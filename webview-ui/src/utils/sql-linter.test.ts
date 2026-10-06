import { describe, it, expect } from 'vitest';
import { diagnoseSql } from './sql-linter';

describe('diagnoseSql', () => {
  it('与宿主确认同一判定: 无 WHERE 的 UPDATE 划线, 带 WHERE 的和字符串里的 DROP 不划', () => {
    const sql = "UPDATE t SET a = 1;\nUPDATE t SET a = 1 WHERE id = 2;\nSELECT 'DROP TABLE x';\nDROP TABLE y";
    expect(diagnoseSql(sql, 'mysql').map((w) => sql.slice(w.from, w.to))).toEqual(['UPDATE t SET a = 1', 'DROP TABLE y']);
  });
});
