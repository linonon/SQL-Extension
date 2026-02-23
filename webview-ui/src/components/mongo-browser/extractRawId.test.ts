import { describe, it, expect } from 'vitest';
import { extractRawId } from './MongoDocumentDetail';

describe('extractRawId', () => {
  it('ObjectId 24-char hex -> 提取纯 ID', () => {
    expect(extractRawId('ObjectId("abc123456789012345678901")'))
      .toBe('abc123456789012345678901');
  });

  it('普通字符串 -> 原样返回', () => {
    expect(extractRawId('somestringid')).toBe('somestringid');
  });

  it('空字符串 -> 空字符串', () => {
    expect(extractRawId('')).toBe('');
  });

  it('ObjectId 非 24-char hex -> 原样返回', () => {
    expect(extractRawId('ObjectId("short")')).toBe('ObjectId("short")');
  });

  it('ObjectId 24-char 但含非 hex 字符 -> 原样返回', () => {
    expect(extractRawId('ObjectId("zzzzzzzzzzzzzzzzzzzzzzzz")'))
      .toBe('ObjectId("zzzzzzzzzzzzzzzzzzzzzzzz")');
  });

  it('数字字符串 -> 原样返回', () => {
    expect(extractRawId('12345')).toBe('12345');
  });

  it('大小写混合 hex ObjectId -> 正确提取', () => {
    expect(extractRawId('ObjectId("aAbBcCdDeEfF001122334455")'))
      .toBe('aAbBcCdDeEfF001122334455');
  });
});
