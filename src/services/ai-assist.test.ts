import { describe, expect, it } from 'vitest';
import { buildAiPrompt } from './ai-assist.js';

describe('buildAiPrompt', () => {
  const base = { dialect: 'MySQL', database: 'admin', question: 'q', sql: 'SELECT 1', selection: '' };

  it('includes schema and omits empty selection', () => {
    const p = buildAiPrompt({ ...base, schema: { admin_role: ['id', 'name'] } });
    expect(p).toContain('admin_role(id, name)');
    expect(p).not.toContain('Selected SQL');
  });

  it('puts mentioned tables first so truncation keeps them', () => {
    const schema = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`t${i}`, ['a', 'b', 'c']]));
    const p = buildAiPrompt({ ...base, sql: 'SELECT * FROM t4999', schema });
    expect(p).toContain('t4999(a, b, c)');
    expect(p).toMatch(/more tables truncated/);
  });

  it('truncates huge schema', () => {
    const schema = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`t${i}`, ['a', 'b', 'c']]));
    const p = buildAiPrompt({ ...base, schema });
    expect(p).toMatch(/more tables truncated/);
    expect(p.length).toBeLessThan(32_000);
  });
});
