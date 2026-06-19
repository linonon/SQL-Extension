import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HighlightEditor } from './HighlightEditor';

describe('HighlightEditor', () => {
  it('renders textarea with provided value', () => {
    render(
      <HighlightEditor
        value='{"name": "test"}'
        onChange={() => {}}
        searchQuery=""
        activeMatchIndex={-1}
      />
    );
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue('{"name": "test"}');
  });

  it('calls onChange with raw event when user types', () => {
    const onChange = vi.fn();
    render(
      <HighlightEditor
        value=""
        onChange={onChange}
        searchQuery=""
        activeMatchIndex={-1}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].target.value).toBe('new');
  });

  it('renders highlight marks when searchQuery matches', () => {
    const { container } = render(
      <HighlightEditor
        value='hello world hello'
        onChange={() => {}}
        searchQuery="hello"
        activeMatchIndex={0}
      />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
  });

  it('renders no marks when searchQuery is empty', () => {
    const { container } = render(
      <HighlightEditor
        value='hello world'
        onChange={() => {}}
        searchQuery=""
        activeMatchIndex={-1}
      />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(0);
  });

  it('renders a line-number gutter (one number per logical line)', () => {
    const { container } = render(
      <HighlightEditor value={'{\n  "a": 1\n}'} onChange={() => {}} searchQuery="" activeMatchIndex={-1} />
    );
    const gutters = container.querySelectorAll('.hl-ln');
    expect(gutters).toHaveLength(3);
    expect(gutters[0].textContent).toBe('1');
    expect(gutters[2].textContent).toBe('3');
  });

  it('colorizes tokens (key / number)', () => {
    const { container } = render(
      <HighlightEditor value={'{ "a": 1 }'} onChange={() => {}} searchQuery="" activeMatchIndex={-1} />
    );
    expect(container.querySelector('.hl-tok-key')?.textContent).toBe('"a"');
    expect(container.querySelector('.hl-tok-number')?.textContent).toBe('1');
  });

  it('marks the error line in the gutter', () => {
    const { container } = render(
      <HighlightEditor value={'{\n  bad\n}'} onChange={() => {}} searchQuery="" activeMatchIndex={-1} errorLine={2} />
    );
    const errorRows = container.querySelectorAll('.hl-row-error');
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0].querySelector('.hl-ln')?.textContent).toBe('2');
  });

  it('applies active class to the active match', () => {
    const { container } = render(
      <HighlightEditor
        value='aaa bbb aaa'
        onChange={() => {}}
        searchQuery="aaa"
        activeMatchIndex={1}
      />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks[0]).not.toHaveClass('highlight-active');
    expect(marks[1]).toHaveClass('highlight-active');
  });
});
