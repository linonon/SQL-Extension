import { describe, expect, it } from 'vitest';
import { applySql, extractSqlBlock } from './AiAskBar';

describe('AiAskBar helpers', () => {
  it('extracts the first sql block', () => {
    expect(extractSqlBlock('说明\n```sql\nSELECT 1;\n```\n')).toBe('SELECT 1;');
    expect(extractSqlBlock('no code')).toBeNull();
  });

  it('replaces the selection at its original position, keeping surrounding whitespace', () => {
    const editor = 'SELECT 2;\nSELECT 1;\nSELECT 2;\n';
    // 选中第二个 "SELECT 2;\n" (偏移 20), 不能误改第一个
    expect(applySql(editor, { selection: 'SELECT 2;\n', start: 20 }, 'SELECT 3')).toBe('SELECT 2;\nSELECT 1;\nSELECT 3\n');
  });

  it('replaces the whole editor when nothing was selected', () => {
    expect(applySql('SELECT 1;', { selection: '', start: 0 }, 'SELECT $1;')).toBe('SELECT $1;');
  });

  it('refuses when the selected text changed since asking', () => {
    expect(applySql('SELECT 9;', { selection: 'SELECT 1;', start: 0 }, 'SELECT 3;')).toBeNull();
  });
});
