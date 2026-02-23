import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVSCodeMessage } from './useVSCodeMessage';
import type { ExtensionMessage } from '../types/messages';

describe('useVSCodeMessage', () => {
  it('应该在组件挂载时注册 message listener', () => {
    const handler = vi.fn();
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    renderHook(() => useVSCodeMessage(handler));

    expect(addEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    addEventListenerSpy.mockRestore();
  });

  it('应该在收到 message 事件时调用 handler', () => {
    const handler = vi.fn();
    renderHook(() => useVSCodeMessage(handler));

    const message: ExtensionMessage = {
      type: 'viewInit',
      view: 'table',
      context: { connectionId: 'test-conn' },
    };

    window.dispatchEvent(new MessageEvent('message', { data: message }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(message);
  });

  it('应该在组件卸载时移除 listener', () => {
    const handler = vi.fn();
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useVSCodeMessage(handler));
    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    removeEventListenerSpy.mockRestore();
  });

  it('应该正确处理多个不同类型的 message', () => {
    const handler = vi.fn();
    renderHook(() => useVSCodeMessage(handler));

    const message1: ExtensionMessage = { type: 'error', message: 'Test error' };
    const message2: ExtensionMessage = {
      type: 'queryResult',
      columns: [],
      rows: [],
      affectedRows: 0,
      executionTime: 100,
    };

    window.dispatchEvent(new MessageEvent('message', { data: message1 }));
    window.dispatchEvent(new MessageEvent('message', { data: message2 }));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, message1);
    expect(handler).toHaveBeenNthCalledWith(2, message2);
  });

  it('应该在 handler 变更时重新注册 listener', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const { rerender } = renderHook(
      ({ handler }) => useVSCodeMessage(handler),
      { initialProps: { handler: handler1 } }
    );

    const message: ExtensionMessage = { type: 'error', message: 'Test' };
    window.dispatchEvent(new MessageEvent('message', { data: message }));

    expect(handler1).toHaveBeenCalledWith(message);
    expect(handler2).not.toHaveBeenCalled();

    // 切换 handler
    rerender({ handler: handler2 });

    window.dispatchEvent(new MessageEvent('message', { data: message }));

    expect(handler2).toHaveBeenCalledWith(message);
  });
});
