import { describe, it, expect } from 'vitest';
import { isPoolConnection } from './utils.js';

describe('isPoolConnection', () => {
  it('should return true for pool connection IDs', () => {
    expect(isPoolConnection('conn_1_1234567890')).toBe(true);
    expect(isPoolConnection('conn_99_1234567890')).toBe(true);
  });
  it('should return false for IPC connection IDs', () => {
    expect(isPoolConnection('abc-def-123')).toBe(false);
    expect(isPoolConnection('')).toBe(false);
  });
});
