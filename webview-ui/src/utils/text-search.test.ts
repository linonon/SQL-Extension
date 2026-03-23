import { describe, it, expect } from 'vitest';
import { findMatches, type MatchRange } from './text-search';

describe('findMatches', () => {
  it('returns empty array for empty pattern', () => {
    expect(findMatches('hello world', '')).toEqual([]);
  });

  it('returns empty array when no match', () => {
    expect(findMatches('hello world', 'xyz')).toEqual([]);
  });

  it('finds a single match', () => {
    expect(findMatches('hello world', 'world')).toEqual([
      { start: 6, end: 11 },
    ]);
  });

  it('finds multiple matches', () => {
    expect(findMatches('abcabc', 'abc')).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });

  it('is case-insensitive by default', () => {
    expect(findMatches('Hello HELLO hello', 'hello')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it('supports case-sensitive mode', () => {
    expect(findMatches('Hello HELLO hello', 'hello', true)).toEqual([
      { start: 12, end: 17 },
    ]);
  });

  it('handles overlapping potential matches (non-overlapping result)', () => {
    expect(findMatches('aaa', 'aa')).toEqual([
      { start: 0, end: 2 },
    ]);
  });

  it('returns empty for empty text', () => {
    expect(findMatches('', 'abc')).toEqual([]);
  });
});
