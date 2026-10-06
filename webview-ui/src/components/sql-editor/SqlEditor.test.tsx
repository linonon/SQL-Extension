import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SqlEditor } from './SqlEditor';

const schema = { player: ['level', 'level_exp'], player_bag: ['id'] };

function setup(initial = '') {
  const onExecute = vi.fn();
  const onFormat = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    return <SqlEditor value={value} onChange={setValue} schema={schema} onExecute={onExecute} onFormat={onFormat} />;
  }
  const { container } = render(<Harness />);
  const textarea = screen.getByTestId('sql-editor') as HTMLTextAreaElement;
  textarea.focus();
  return { container, textarea, onExecute, onFormat };
}

// 输入: 改值后光标落在末尾
const type = (textarea: HTMLTextAreaElement, value: string) => fireEvent.change(textarea, { target: { value } });
const popupItems = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('SqlEditor 补全弹窗', () => {
  it('弹窗可见时 Ctrl/Cmd+Enter 执行而不补全, 并带上光标位置', () => {
    const { textarea, onExecute } = setup();
    type(textarea, 'SELECT * FROM pl');
    expect(popupItems()).toEqual(['player', 'player_bag']);

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', metaKey: true });
    expect(onExecute).toHaveBeenLastCalledWith(16);
    expect(textarea.value).toBe('SELECT * FROM pl');
    expect(popupItems()).toEqual([]);

    type(textarea, 'SELECT * FROM pla');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', ctrlKey: true });
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(textarea.value).toBe('SELECT * FROM pla');
  });

  it('带 Shift / Alt 的 Enter 与 Shift+Tab 不被弹窗吃掉', () => {
    const { textarea } = setup();
    type(textarea, 'SELECT * FROM pl');
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', altKey: true })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: 'Tab', code: 'Tab', shiftKey: true })).toBe(true);
    expect(textarea.value).toBe('SELECT * FROM pl');
  });

  it('输入法组字中的 Enter 与 Shift+方向键不被弹窗拦截', () => {
    const { textarea, onExecute } = setup();
    type(textarea, 'SELECT * FROM pl');
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 229 })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true, metaKey: true })).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true })).toBe(true);
    expect(textarea.value).toBe('SELECT * FROM pl');
    expect(popupItems()).toEqual(['player', 'player_bag']);
  });

  it('不带修饰键的 Enter 套用选中项', () => {
    const { textarea } = setup();
    type(textarea, 'SELECT * FROM pl');
    fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(textarea.value).toBe('SELECT * FROM player_bag');
    expect(popupItems()).toEqual([]);
  });

  it('已打出完整的表名 / 关键字时不弹, Enter 留给换行', () => {
    const { textarea } = setup();
    type(textarea, 'SELECT * FROM player');
    expect(popupItems()).toEqual([]);
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })).toBe(true);

    type(textarea, 'SELECT * FROM player WHERE level = 1 OR');
    expect(popupItems()).toEqual([]);
  });

  it('失焦 / 光标被点到别处 / Escape 时关闭, 光标仍在原处则保留', () => {
    const { textarea } = setup();
    type(textarea, 'SELECT * FROM pl');
    fireEvent.blur(textarea);
    expect(popupItems()).toEqual([]);

    type(textarea, 'SELECT * FROM pla');
    fireEvent.mouseDown(textarea);
    fireEvent.mouseUp(textarea);
    expect(popupItems()).toEqual(['player', 'player_bag']);
    textarea.setSelectionRange(0, 0);
    fireEvent.mouseDown(textarea);
    fireEvent.mouseUp(textarea);
    expect(popupItems()).toEqual([]);

    type(textarea, 'SELECT * FROM pl');
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' });
    expect(popupItems()).toEqual([]);
  });
});

describe('SqlEditor 快捷键与滚动', () => {
  it('Shift+Alt+F 按物理键触发格式化 (Shift 时 key 为 F, macOS Option 时为别的字形)', () => {
    const { textarea, onFormat } = setup('select 1');
    fireEvent.keyDown(textarea, { key: 'F', code: 'KeyF', shiftKey: true, altKey: true });
    fireEvent.keyDown(textarea, { key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true });
    fireEvent.keyDown(textarea, { key: 'ƒ', code: 'KeyF', altKey: true });
    expect(onFormat).toHaveBeenCalledTimes(2);
  });

  it('高亮层与行号跟随 textarea 的 scrollTop / scrollLeft', () => {
    const long = Array.from({ length: 200 }, (_, i) => `SELECT ${'x'.repeat(300)} AS c${i};`).join('\n');
    const { container, textarea } = setup(long);
    const highlight = container.querySelector('.sql-editor-highlight') as HTMLElement;
    const gutter = container.querySelector('.sql-editor-gutter') as HTMLElement;
    expect(gutter.children).toHaveLength(200);

    textarea.scrollTop = 1200;
    textarea.scrollLeft = 640;
    fireEvent.scroll(textarea);
    expect([highlight.scrollTop, highlight.scrollLeft, gutter.scrollTop]).toEqual([1200, 640, 1200]);
  });
});
