import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePostMessage } from './usePostMessage';
import { mockPostMessage } from '../__test__/setup';
import type { WebviewMessage } from '../types/messages';

describe('usePostMessage', () => {
  it('应该返回一个稳定的 postMessage 函数', () => {
    const { result, rerender } = renderHook(() => usePostMessage());

    const firstInstance = result.current;
    rerender();
    const secondInstance = result.current;

    expect(firstInstance).toBe(secondInstance);
  });

  it('应该正确调用 vscodeApi.postMessage 发送 ready 消息', () => {
    const { result } = renderHook(() => usePostMessage());

    const message: WebviewMessage = { type: 'ready' };

    act(() => {
      result.current(message);
    });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(message);
  });

  it('应该正确发送 fetchRows 消息', () => {
    const { result } = renderHook(() => usePostMessage());

    const message: WebviewMessage = {
      type: 'fetchRows',
      database: 'test_db',
      table: 'users',
      offset: 0,
      limit: 100,
    };

    act(() => {
      result.current(message);
    });

    expect(mockPostMessage).toHaveBeenCalledWith(message);
  });

  it('应该正确发送 executeQuery 消息', () => {
    const { result } = renderHook(() => usePostMessage());

    const message: WebviewMessage = {
      type: 'executeQuery',
      database: 'test_db',
      sql: 'SELECT * FROM users',
    };

    act(() => {
      result.current(message);
    });

    expect(mockPostMessage).toHaveBeenCalledWith(message);
  });

  it('应该正确发送 testConnection 消息', () => {
    const { result } = renderHook(() => usePostMessage());

    const message: WebviewMessage = {
      type: 'testConnection',
      config: {
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'test',
      },
    };

    act(() => {
      result.current(message);
    });

    expect(mockPostMessage).toHaveBeenCalledWith(message);
  });

  it('应该正确发送 saveConnection 消息', () => {
    const { result } = renderHook(() => usePostMessage());

    const message: WebviewMessage = {
      type: 'saveConnection',
      config: {
        name: 'My DB',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'pass',
        database: 'mydb',
      },
    };

    act(() => {
      result.current(message);
    });

    expect(mockPostMessage).toHaveBeenCalledWith(message);
  });

  it('应该正确发送 deleteRows 消息', () => {
    const { result } = renderHook(() => usePostMessage());

    const message: WebviewMessage = {
      type: 'deleteRows',
      database: 'test_db',
      table: 'users',
      primaryKeys: [{ id: 1 }, { id: 2 }],
    };

    act(() => {
      result.current(message);
    });

    expect(mockPostMessage).toHaveBeenCalledWith(message);
  });
});
