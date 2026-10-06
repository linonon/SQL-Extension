import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AiAskBar, applySql, extractSqlBlock } from './AiAskBar';
import { mockPostMessage } from '../../__test__/setup';

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

describe('AiAskBar 输入框', () => {
  const setup = () => {
    const onClose = vi.fn();
    render(createElement(AiAskBar, { database: 'db', sql: 'SELECT 1', selection: '', selectionStart: 0, onApply: vi.fn(), onClose }));
    const input = screen.getByTestId('ai-ask-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'first line' } });
    const asked = () => mockPostMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'aiAsk');
    return { input, onClose, asked };
  };

  it('多行输入: Shift+Enter 留给换行不提交, Enter 提交整段', () => {
    const { input, asked } = setup();
    expect(input.tagName).toBe('TEXTAREA');
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true })).toBe(true);
    expect(asked()).toHaveLength(0);

    fireEvent.change(input, { target: { value: 'first line\nsecond line' } });
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(asked()).toHaveLength(1);
    expect(asked()[0].question).toBe('first line\nsecond line');
  });

  it('输入法组字中的 Enter / Esc 既不提交也不关闭; 组字外 Esc 关闭', () => {
    const { input, onClose, asked } = setup();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape', isComposing: true });
    expect(asked()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('提问没送到 (宿主回笼统 error): 结束 busy, 可以重新提问', () => {
    const { input, asked } = setup();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();

    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Failed to connect: x' } })); });
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(asked()).toHaveLength(2);
  });
});
