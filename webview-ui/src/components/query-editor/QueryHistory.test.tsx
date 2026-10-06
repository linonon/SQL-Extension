import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryHistory } from './QueryHistory';
import { mockPostMessage } from '../../__test__/setup';
import type { ExtensionMessage } from '../../types/messages';

const send = (data: ExtensionMessage) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });

describe('QueryHistory', () => {
  it('打开时向宿主要本连接的历史; 按 SQL / 库名过滤; 点一条交给编辑器', () => {
    const onSelect = vi.fn();
    render(<QueryHistory onSelect={onSelect} />);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'listQueryHistory' });
    send({
      type: 'queryHistory',
      entries: [
        { sql: 'SELECT * FROM orders', database: 'shop', ts: 2, ok: false },
        { sql: 'SELECT * FROM users', database: 'game', ts: 1, ok: true },
      ],
    });
    expect(screen.getByText(/failed \| shop/)).toBeInTheDocument();

    const filter = screen.getByPlaceholderText('Filter history...');
    fireEvent.change(filter, { target: { value: 'GAME' } });
    expect(screen.queryByText('SELECT * FROM orders')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('SELECT * FROM users'));
    expect(onSelect).toHaveBeenCalledWith('SELECT * FROM users');

    fireEvent.change(filter, { target: { value: 'nothing' } });
    expect(screen.getByText('No match')).toBeInTheDocument();
  });
});
