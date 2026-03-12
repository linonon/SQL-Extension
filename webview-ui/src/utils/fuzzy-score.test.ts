import { describe, it, expect } from 'vitest';
import { fuzzyScore } from './fuzzy-score';

describe('fuzzyScore', () => {
  it('returns 0 for empty pattern', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('returns -1 for no match', () => {
    expect(fuzzyScore('xyz', 'abc')).toBe(-1);
  });

  it('matches exact substring', () => {
    expect(fuzzyScore('user', 'users')).toBeGreaterThan(0);
  });

  it('matches non-contiguous characters', () => {
    expect(fuzzyScore('usr', 'user_stories')).toBeGreaterThan(0);
  });

  it('scores exact prefix higher than mid-word match', () => {
    const prefixScore = fuzzyScore('user', 'user_table');
    const midScore = fuzzyScore('user', 'super_user');
    expect(prefixScore).toBeGreaterThan(midScore);
  });

  it('scores consecutive match higher than scattered match', () => {
    const consecutive = fuzzyScore('log', 'login');
    const scattered = fuzzyScore('log', 'loading_config');
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('scores word boundary match higher than mid-word', () => {
    const boundary = fuzzyScore('ct', 'create_table');
    const midWord = fuzzyScore('ct', 'factory');
    expect(boundary).toBeGreaterThan(midWord);
  });

  it('is case insensitive', () => {
    expect(fuzzyScore('USER', 'user_table')).toBeGreaterThan(0);
    expect(fuzzyScore('user', 'USER_TABLE')).toBeGreaterThan(0);
  });
});
