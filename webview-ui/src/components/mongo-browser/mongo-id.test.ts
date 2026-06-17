import { describe, it, expect } from 'vitest';
import { idToShell } from './mongo-id';

describe('idToShell', () => {
  it('ObjectId shell-tag -> 原样 (本就是合法 shell 语法)', () => {
    expect(idToShell('ObjectId("507f1f77bcf86cd799439011")'))
      .toBe('ObjectId("507f1f77bcf86cd799439011")');
  });

  it('数字 _id -> 裸数字, 不加引号 (保留数值类型)', () => {
    expect(idToShell(1102025811)).toBe('1102025811');
  });

  it('普通字符串 _id -> JSON 加引号', () => {
    expect(idToShell('abc123')).toBe('"abc123"');
  });

  it('NumberLong shell-tag -> 原样', () => {
    expect(idToShell('NumberLong("9999999999")')).toBe('NumberLong("9999999999")');
  });

  it('ISODate shell-tag -> 原样', () => {
    expect(idToShell('ISODate("2024-01-15T00:00:00.000Z")'))
      .toBe('ISODate("2024-01-15T00:00:00.000Z")');
  });

  it('含双引号的字符串 _id -> 安全转义', () => {
    expect(idToShell('a"b')).toBe('"a\\"b"');
  });

  it('boolean / null -> JSON 字面量', () => {
    expect(idToShell(true)).toBe('true');
    expect(idToShell(null)).toBe('null');
  });

  it('undefined (投影排除 _id) -> 空串, 不返回 undefined — M7', () => {
    expect(idToShell(undefined)).toBe('');
  });
});
