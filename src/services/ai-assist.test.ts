import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildAiPrompt, effectiveModelId, resolveAiModel } from './ai-assist.js';
import { claudeCodeAvailable } from './claude-code.js';
import type { SchemaColumn } from '../types/query.js';

vi.mock('./claude-code.js', async (orig) => ({
  ...(await orig<typeof import('./claude-code.js')>()),
  claudeCodeAvailable: vi.fn(async () => '/bin/claude'),
}));

// 表名 -> 列名, 列类型统一 int, 无注释
const schemaOf = (tables: Record<string, string[]>): Record<string, SchemaColumn[]> =>
  Object.fromEntries(Object.entries(tables).map(([t, cols]) => [t, cols.map((name) => ({ table: t, name, type: 'int', comment: '' }))]));

describe('buildAiPrompt', () => {
  const base = { dialect: 'MySQL', database: 'admin', question: 'q', sql: 'SELECT 1', selection: '' };

  it('includes schema and omits empty selection / last error', () => {
    const p = buildAiPrompt({ ...base, schema: schemaOf({ admin_role: ['id', 'name'] }) });
    expect(p).toContain('admin_role(id, name)');
    expect(p).not.toContain('Selected SQL');
    expect(p).not.toContain('Last error');
  });

  it('mentioned tables list column type and comment; others keep names only; last error is included', () => {
    const schema: Record<string, SchemaColumn[]> = {
      t_user: [
        { table: 't_user', name: 'id', type: 'bigint(20)', comment: '' },
        { table: 't_user', name: 'status', type: 'tinyint(4)', comment: '0 正常\n1 封禁' },
      ],
      t_order: [{ table: 't_order', name: 'id', type: 'bigint(20)', comment: 'x' }],
    };
    const p = buildAiPrompt({ ...base, sql: 'SELECT * FROM t_user WHERE stat = 1', schema, lastError: "Unknown column 'stat' in 'where clause'" });
    expect(p).toContain('t_user:\n  id bigint(20)\n  status tinyint(4) -- 0 正常 1 封禁');
    expect(p).toContain('t_order(id)');
    expect(p).toContain("Last error (the previous execution in this editor failed with):\nUnknown column 'stat' in 'where clause'");
  });

  it('puts mentioned tables first so truncation keeps them', () => {
    const schema = schemaOf(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`t${i}`, ['a', 'b', 'c']])));
    const p = buildAiPrompt({ ...base, sql: 'SELECT * FROM t4999', schema });
    expect(p).toContain('t4999:\n  a int\n  b int\n  c int');
    expect(p).toMatch(/more tables truncated/);
  });

  it('a mentioned table too wide for details falls back to names only, later tables still fit', () => {
    const wide = Array.from({ length: 400 }, (_, i) => ({ table: 'wide', name: `c${i}`, type: 'varchar(255)', comment: 'x'.repeat(80) }));
    const p = buildAiPrompt({ ...base, sql: 'SELECT * FROM wide', schema: { wide, t_small: schemaOf({ t_small: ['id'] }).t_small } });
    expect(p).toContain('wide(c0, c1, c2');
    expect(p).toContain('t_small(id)');
    expect(p).not.toMatch(/more tables truncated/);
  });

  it('truncates huge schema', () => {
    const schema = schemaOf(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`t${i}`, ['a', 'b', 'c']])));
    const p = buildAiPrompt({ ...base, schema });
    expect(p).toMatch(/more tables truncated/);
    expect(p.length).toBeLessThan(32_000);
  });
});

describe('effectiveModelId', () => {
  const copilot = [{ id: 'gpt-4o' }, { id: 'claude-sonnet' }];

  it('uses the setting when it is available', () => {
    expect(effectiveModelId('claude-sonnet', copilot)).toBe('claude-sonnet');
  });

  it('Claude Code set but not logged in: falls back to the first listed model, as the dropdown shows', () => {
    expect(effectiveModelId('claude-code:sonnet', copilot)).toBe('gpt-4o');
    expect(effectiveModelId('', [{ id: 'claude-code:sonnet' }, ...copilot])).toBe('claude-code:sonnet');
    expect(effectiveModelId('claude-code:opus', [])).toBe('');
  });
});

describe('resolveAiModel', () => {
  const setting = (v: string) =>
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => v } as never);

  beforeEach(() => {
    vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([{ id: 'gpt-4o', name: 'GPT-4o' }] as never);
    vi.mocked(claudeCodeAvailable).mockClear();
  });

  it('a listed Copilot model is used without probing Claude Code', async () => {
    setting('gpt-4o');
    expect((await resolveAiModel()).chosen).toBe('gpt-4o');
    expect(claudeCodeAvailable).not.toHaveBeenCalled();
  });

  it('empty / Claude Code / unlisted settings probe Claude Code, same pick as the dropdown', async () => {
    for (const [v, want] of [['', 'claude-code:sonnet'], ['claude-code:opus', 'claude-code:opus'], ['gone', 'claude-code:sonnet']]) {
      setting(v);
      expect((await resolveAiModel()).chosen).toBe(want);
    }
    expect(claudeCodeAvailable).toHaveBeenCalledTimes(3);
  });
});
