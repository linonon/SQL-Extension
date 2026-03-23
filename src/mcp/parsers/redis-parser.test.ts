import { describe, it, expect } from 'vitest';
import { parseRedisCommand } from './redis-parser.js';

describe('parseRedisCommand', () => {
  it('should parse simple command', () => {
    expect(parseRedisCommand('GET user:1')).toEqual(['GET', 'user:1']);
  });
  it('should parse multi-arg command', () => {
    expect(parseRedisCommand('SET key val EX 60')).toEqual(['SET', 'key', 'val', 'EX', '60']);
  });
  it('should handle quoted values with spaces', () => {
    expect(parseRedisCommand('SET key "hello world"')).toEqual(['SET', 'key', 'hello world']);
  });
  it('should handle single-quoted values', () => {
    expect(parseRedisCommand("SET key 'hello world'")).toEqual(['SET', 'key', 'hello world']);
  });
  it('should parse single-word command', () => {
    expect(parseRedisCommand('FLUSHDB')).toEqual(['FLUSHDB']);
  });
  it('should trim whitespace', () => {
    expect(parseRedisCommand('  GET  key  ')).toEqual(['GET', 'key']);
  });
  it('should throw on empty input', () => {
    expect(() => parseRedisCommand('')).toThrow();
    expect(() => parseRedisCommand('   ')).toThrow();
  });
});
