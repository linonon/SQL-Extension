import { describe, it, expect } from 'vitest';
import { ALLOWED_COMMANDS, capScanCount } from './redis.js';

describe('redis_command - whitelist', () => {
  it('should include all expected read-only commands', () => {
    const expected = [
      'GET', 'MGET', 'TTL', 'PTTL', 'TYPE', 'EXISTS', 'DBSIZE', 'INFO',
      'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN',
      'HGET', 'HGETALL', 'HMGET', 'HLEN',
      'LRANGE', 'LLEN',
      'SCARD', 'SMEMBERS', 'SISMEMBER',
      'ZCARD', 'ZRANGE', 'ZRANGEBYSCORE', 'ZCOUNT',
      'STRLEN',
    ];
    for (const cmd of expected) {
      expect(ALLOWED_COMMANDS.has(cmd), `missing: ${cmd}`).toBe(true);
    }
  });

  it('should not include write commands', () => {
    const forbidden = ['SET', 'DEL', 'FLUSHDB', 'FLUSHALL', 'KEYS', 'EXPIRE', 'RENAME', 'RPUSH', 'LPUSH'];
    for (const cmd of forbidden) {
      expect(ALLOWED_COMMANDS.has(cmd), `should not allow: ${cmd}`).toBe(false);
    }
  });
});

describe('redis_command - capScanCount', () => {
  it('should cap SCAN COUNT above 1000', () => {
    const result = capScanCount(['SCAN', '0', 'COUNT', '5000']);
    expect(result).toEqual(['SCAN', '0', 'COUNT', '1000']);
  });

  it('should leave SCAN COUNT at or below 1000 unchanged', () => {
    const result = capScanCount(['SCAN', '0', 'COUNT', '100']);
    expect(result).toEqual(['SCAN', '0', 'COUNT', '100']);
  });

  it('should cap HSCAN COUNT above 1000', () => {
    const result = capScanCount(['HSCAN', 'myhash', '0', 'COUNT', '2000']);
    expect(result).toEqual(['HSCAN', 'myhash', '0', 'COUNT', '1000']);
  });

  it('should handle SCAN with MATCH and COUNT', () => {
    const result = capScanCount(['SCAN', '0', 'MATCH', 'user:*', 'COUNT', '9999']);
    expect(result).toEqual(['SCAN', '0', 'MATCH', 'user:*', 'COUNT', '1000']);
  });

  it('should not modify non-SCAN commands', () => {
    const result = capScanCount(['GET', 'mykey']);
    expect(result).toEqual(['GET', 'mykey']);
  });

  it('should handle SCAN without COUNT', () => {
    const result = capScanCount(['SCAN', '0', 'MATCH', 'user:*']);
    expect(result).toEqual(['SCAN', '0', 'MATCH', 'user:*']);
  });

  it('should handle empty args', () => {
    const result = capScanCount([]);
    expect(result).toEqual([]);
  });

  it('should be case-insensitive for COUNT keyword', () => {
    const result = capScanCount(['SCAN', '0', 'count', '5000']);
    expect(result).toEqual(['SCAN', '0', 'count', '1000']);
  });

  it('should be case-insensitive for command name', () => {
    const result = capScanCount(['scan', '0', 'COUNT', '5000']);
    expect(result).toEqual(['scan', '0', 'COUNT', '1000']);
  });
});
