import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RedisBrowser } from './RedisBrowser';
import { mockPostMessage } from '../../__test__/setup';
import type { ExtensionMessage } from '../../../../src/types/messages';

vi.mock('./RedisToolbar', () => ({
  RedisToolbar: (props: any) => (
    <div data-testid="redis-toolbar" data-db={props.database} data-command={props.commandText}>
      <button data-testid="refresh" onClick={props.onRefresh}>Refresh</button>
      <button data-testid="search" onClick={() => props.onSearch('user:*')}>Search</button>
      <button data-testid="export" onClick={props.onExport}>Export</button>
    </div>
  ),
}));

vi.mock('./RedisKeyList', () => ({
  RedisKeyList: (props: any) => (
    <div data-testid="redis-key-list" data-scanning={String(props.scanning)}>
      {props.keys.map((k: any) => (
        <div key={k.key} data-testid={`key-${k.key}`} onClick={() => props.onSelectKey(k.key)}>
          {k.key}
        </div>
      ))}
      {props.hasMore && <button data-testid="load-more" onClick={props.onLoadMore}>Load More</button>}
    </div>
  ),
}));

vi.mock('./RedisValueViewer', () => ({
  RedisValueViewer: (props: any) => (
    <div data-testid="redis-value-viewer" data-key={props.keyName} data-set-has-more={String(props.setHasMore)} data-value={JSON.stringify(props.value)}>
      {props.value && <span data-testid="value-type">{props.value.type}</span>}
      {props.setHasMore && <button data-testid="set-load-more" onClick={props.onSetLoadMore}>Set Load More</button>}
      {props.listHasMore && <button data-testid="list-load-more" onClick={props.onListLoadMore}>List Load More</button>}
    </div>
  ),
}));

vi.mock('../../styles/redis-browser.css', () => ({}));

// 回执须带回最近一次 redisScan 的 requestId 才会被采用
const lastScanId = (): number =>
  [...mockPostMessage.mock.calls].reverse().find(([m]) => m.type === 'redisScan')![0].requestId;

describe('RedisBrowser', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('初始渲染发 redisScan 消息', () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'redisScan',
      requestId: expect.any(Number),
      database: 0,
      pattern: '*',
      cursor: '0',
      count: 100,
    });
  });

  it('redisScanResult 更新 key 列表 + 去重', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);

    const msg: ExtensionMessage = {
      type: 'redisScanResult', scanned: 1000,
      requestId: lastScanId(),
      keys: [{ key: 'k1', type: 'string', ttl: -1 }, { key: 'k2', type: 'hash', ttl: 300 }],
      cursor: '5',
      done: false,
    };
    window.dispatchEvent(new MessageEvent('message', { data: msg }));

    await waitFor(() => {
      expect(screen.getByTestId('key-k1')).toBeInTheDocument();
      expect(screen.getByTestId('key-k2')).toBeInTheDocument();
    });

    // 发送重复 key, 不应该重复出现
    const msg2: ExtensionMessage = {
      type: 'redisScanResult', scanned: 1000,
      requestId: lastScanId(),
      keys: [{ key: 'k1', type: 'string', ttl: -1 }, { key: 'k3', type: 'list', ttl: -1 }],
      cursor: '0',
      done: true,
    };
    window.dispatchEvent(new MessageEvent('message', { data: msg2 }));

    await waitFor(() => {
      expect(screen.getByTestId('key-k3')).toBeInTheDocument();
      expect(screen.getAllByTestId(/^key-k1$/).length).toBe(1);
    });
  });

  it('done=false 时 hasMore=true, done=true 时 hasMore=false', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);

    const msg1: ExtensionMessage = {
      type: 'redisScanResult', scanned: 1000,
      requestId: lastScanId(),
      keys: [{ key: 'k1', type: 'string', ttl: -1 }],
      cursor: '5',
      done: false,
    };
    window.dispatchEvent(new MessageEvent('message', { data: msg1 }));

    await waitFor(() => {
      expect(screen.getByTestId('load-more')).toBeInTheDocument();
    });

    const msg2: ExtensionMessage = {
      type: 'redisScanResult', scanned: 1000,
      requestId: lastScanId(),
      keys: [],
      cursor: '0',
      done: true,
    };
    window.dispatchEvent(new MessageEvent('message', { data: msg2 }));

    await waitFor(() => {
      expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
    });
  });

  it('selectKey 发 redisGetValue', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    const scanId = lastScanId();
    mockPostMessage.mockClear();

    // 先加载 keys
    const scanMsg: ExtensionMessage = {
      type: 'redisScanResult', scanned: 1000,
      requestId: scanId,
      keys: [{ key: 'mykey', type: 'string', ttl: -1 }],
      cursor: '0',
      done: true,
    };
    window.dispatchEvent(new MessageEvent('message', { data: scanMsg }));

    await waitFor(() => {
      screen.getByTestId('key-mykey').click();
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'redisGetValue',
      key: 'mykey',
      database: 0,
    });
  });

  it('redisValueResult 更新 value', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);

    // 先选中 key
    const scanMsg: ExtensionMessage = {
      type: 'redisScanResult', scanned: 1000,
      requestId: lastScanId(),
      keys: [{ key: 'k1', type: 'string', ttl: -1 }],
      cursor: '0',
      done: true,
    };
    window.dispatchEvent(new MessageEvent('message', { data: scanMsg }));

    await waitFor(() => screen.getByTestId('key-k1').click());

    const valueMsg: ExtensionMessage = {
      type: 'redisValueResult',
      key: 'k1',
      database: 0,
      keyType: 'string',
      value: { type: 'string', value: 'hello' },
      ttl: -1,
    };
    window.dispatchEvent(new MessageEvent('message', { data: valueMsg }));

    await waitFor(() => {
      expect(screen.getByTestId('value-type')).toHaveTextContent('string');
    });
  });

  it('handleSetLoadMore 发 redisGetValue 带 setCursor (#2)', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);

    // 加载 key
    const scanMsg: ExtensionMessage = {
      type: 'redisScanResult', scanned: 1000,
      requestId: lastScanId(),
      keys: [{ key: 's1', type: 'set', ttl: -1 }],
      cursor: '0',
      done: true,
    };
    window.dispatchEvent(new MessageEvent('message', { data: scanMsg }));
    await waitFor(() => screen.getByTestId('key-s1').click());

    // 收到 set value 带 cursor
    const valueMsg: ExtensionMessage = {
      type: 'redisValueResult',
      key: 's1',
      database: 0,
      keyType: 'set',
      value: { type: 'set', value: ['m1', 'm2'], cursor: '5' },
      ttl: -1,
    };
    window.dispatchEvent(new MessageEvent('message', { data: valueMsg }));
    mockPostMessage.mockClear();

    await waitFor(() => {
      expect(screen.getByTestId('set-load-more')).toBeInTheDocument();
    });

    screen.getByTestId('set-load-more').click();

    await waitFor(() => {
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'redisGetValue',
          key: 's1',
          database: 0,
          setCursor: '5',
        })
      );
    });
  });

  it('set 分页: memberHasMore 正确更新 (#1, #8)', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);

    const scanMsg: ExtensionMessage = {
      type: 'redisScanResult', scanned: 1000,
      requestId: lastScanId(),
      keys: [{ key: 's1', type: 'set', ttl: -1 }],
      cursor: '0',
      done: true,
    };
    window.dispatchEvent(new MessageEvent('message', { data: scanMsg }));
    await waitFor(() => screen.getByTestId('key-s1').click());

    // cursor !== '0' -> memberHasMore = true
    const valueMsg: ExtensionMessage = {
      type: 'redisValueResult',
      key: 's1',
      database: 0,
      keyType: 'set',
      value: { type: 'set', value: ['m1'], cursor: '3' },
      ttl: -1,
    };
    window.dispatchEvent(new MessageEvent('message', { data: valueMsg }));

    await waitFor(() => {
      expect(screen.getByTestId('redis-value-viewer')).toHaveAttribute('data-set-has-more', 'true');
    });

    // cursor === '0' -> memberHasMore = false
    const valueMsg2: ExtensionMessage = {
      type: 'redisValueResult',
      key: 's1',
      database: 0,
      keyType: 'set',
      value: { type: 'set', value: ['m2'], cursor: '0' },
      ttl: -1,
    };
    window.dispatchEvent(new MessageEvent('message', { data: valueMsg2 }));

    await waitFor(() => {
      expect(screen.getByTestId('redis-value-viewer')).toHaveAttribute('data-set-has-more', 'false');
    });
  });

  it('迟到的旧 SCAN 回执 (requestId 不是最近一次) 不并进当前列表', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    const staleId = lastScanId();
    // 刷新发出新一轮 SCAN, 之后旧一轮的回执才到
    screen.getByTestId('refresh').click();
    const currentId = lastScanId();
    expect(currentId).not.toBe(staleId);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisScanResult', scanned: 1000, requestId: staleId, keys: [{ key: 'old', type: 'string', ttl: -1 }], cursor: '9', done: false,
    } satisfies ExtensionMessage }));
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisScanResult', scanned: 1000, requestId: currentId, keys: [{ key: 'cur', type: 'string', ttl: -1 }], cursor: '0', done: true,
    } satisfies ExtensionMessage }));
    await waitFor(() => expect(screen.getByTestId('key-cur')).toBeInTheDocument());
    expect(screen.queryByTestId('key-old')).not.toBeInTheDocument();
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
  });

  it('选中 key 已换: 旧 key 的取值回执与 hash 分页回执都丢弃', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisScanResult', scanned: 1000, requestId: lastScanId(), cursor: '0', done: true,
      keys: [{ key: 'a', type: 'string', ttl: -1 }, { key: 'b', type: 'hash', ttl: -1 }],
    } satisfies ExtensionMessage }));
    await waitFor(() => screen.getByTestId('key-a').click());
    screen.getByTestId('key-b').click();

    // a 的 GET 晚于点 b 才到: 不能显示在 b 下 (否则 Save 会 SET b)
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisValueResult', key: 'a', database: 0, keyType: 'string', value: { type: 'string', value: 'A' }, ttl: -1,
    } satisfies ExtensionMessage }));
    // 同名 key 但不是当前库的回执也丢
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisValueResult', key: 'b', database: 3, keyType: 'string', value: { type: 'string', value: 'B3' }, ttl: -1,
    } satisfies ExtensionMessage }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('value-type')).not.toBeInTheDocument();

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisValueResult', key: 'b', database: 0, keyType: 'hash', value: { type: 'hash', value: { f: '1' }, cursor: '7' }, ttl: -1,
    } satisfies ExtensionMessage }));
    await waitFor(() => expect(screen.getByTestId('value-type')).toHaveTextContent('hash'));

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisHashScanResult', key: 'a', database: 0, cursor: '0', fields: { leaked: 'x' }, done: true,
    } satisfies ExtensionMessage }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('redis-value-viewer').getAttribute('data-value')).not.toContain('leaked');
  });

  it('换 key 后回执未到前不显示上一个 key 的值', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisScanResult', scanned: 1000, requestId: lastScanId(), cursor: '0', done: true,
      keys: [{ key: 'a', type: 'string', ttl: -1 }, { key: 'b', type: 'string', ttl: -1 }],
    } satisfies ExtensionMessage }));
    await waitFor(() => screen.getByTestId('key-a').click());
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisValueResult', key: 'a', database: 0, keyType: 'string', value: { type: 'string', value: 'A' }, ttl: -1,
    } satisfies ExtensionMessage }));
    await waitFor(() => expect(screen.getByTestId('value-type')).toBeInTheDocument());

    screen.getByTestId('key-b').click();
    await waitFor(() => expect(screen.queryByTestId('value-type')).not.toBeInTheDocument());
  });

  it('Load More 未回就换 key: 新 key 首屏替换而非追加到旧 key 的成员上', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisScanResult', scanned: 1000, requestId: lastScanId(), cursor: '0', done: true,
      keys: [{ key: 'sa', type: 'set', ttl: -1 }, { key: 'sb', type: 'set', ttl: -1 }],
    } satisfies ExtensionMessage }));
    await waitFor(() => screen.getByTestId('key-sa').click());
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisValueResult', key: 'sa', database: 0, keyType: 'set', value: { type: 'set', value: ['a1'], cursor: '5' }, ttl: -1,
    } satisfies ExtensionMessage }));
    await waitFor(() => screen.getByTestId('set-load-more').click());

    // sa 的下一页还没回, 先换到 sb
    screen.getByTestId('key-sb').click();
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisValueResult', key: 'sb', database: 0, keyType: 'set', value: { type: 'set', value: ['b1'], cursor: '0' }, ttl: -1,
    } satisfies ExtensionMessage }));

    await waitFor(() => expect(screen.getByTestId('redis-value-viewer').getAttribute('data-value')).toContain('b1'));
    expect(JSON.parse(screen.getByTestId('redis-value-viewer').getAttribute('data-value')!).value).toEqual(['b1']);
  });

  it('导入完成后按最近一次搜索的 pattern 重扫; Export 发当前库与 pattern', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    fireEvent.click(screen.getByTestId('search'));
    mockPostMessage.mockClear();

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisImportResult', success: true, importedCount: 1,
    } satisfies ExtensionMessage }));

    await waitFor(() => expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redisScan', pattern: 'user:*' }),
    ));
    fireEvent.click(screen.getByTestId('export'));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'redisExportPattern', database: 0, pattern: 'user:*' });
  });

  it('host 回笼统 error (连接已断开) 时结束 Scanning (提示由 App 显示)', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    expect(screen.getByTestId('redis-key-list').getAttribute('data-scanning')).toBe('true');

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'No active connection: conn1' } }));
    await waitFor(() => expect(screen.getByTestId('redis-key-list').getAttribute('data-scanning')).toBe('false'));
  });

  it('操作失败行内显示 (webview 里 alert 不弹), 下一次成功后清掉', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<RedisBrowser connectionId="conn1" database={0} />);

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisOperationResult', success: false, error: 'WRONGTYPE Operation against a key',
    } satisfies ExtensionMessage }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Operation failed: WRONGTYPE Operation against a key');
    expect(alertSpy).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'redisOperationResult', success: true } satisfies ExtensionMessage }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    alertSpy.mockRestore();
  });

  it('一次搜索只发一遍 SCAN', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    mockPostMessage.mockClear();
    fireEvent.click(screen.getByTestId('search'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockPostMessage.mock.calls.filter(([m]) => m.type === 'redisScan')).toHaveLength(1);
  });

  it('选中集合类 key 时预填有界命令', async () => {
    render(<RedisBrowser connectionId="conn1" database={0} />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'redisScanResult', scanned: 1000, requestId: lastScanId(), cursor: '0', done: true,
      keys: [{ key: 'l', type: 'list', ttl: -1 }, { key: 's', type: 'set', ttl: -1 }, { key: 'z', type: 'zset', ttl: -1 }],
    } satisfies ExtensionMessage }));
    const command = () => screen.getByTestId('redis-toolbar').getAttribute('data-command');
    await waitFor(() => screen.getByTestId('key-l').click());
    expect(command()).toBe('LRANGE l 0 99');
    screen.getByTestId('key-s').click();
    await waitFor(() => expect(command()).toBe('SSCAN s 0 COUNT 100'));
    screen.getByTestId('key-z').click();
    await waitFor(() => expect(command()).toBe('ZRANGE z 0 99 WITHSCORES'));
  });

  it('list 写成功后重拉首屏, 下一次 Load More 从已加载末尾接着取; 接不上末尾的旧页丢弃', async () => {
    const page = (start: number, n: number) => Array.from({ length: n }, (_, i) => `v${start + i}`);
    const listResult = (start: number, n: number): ExtensionMessage => ({
      type: 'redisValueResult', key: 'l', database: 0, keyType: 'list', ttl: -1,
      value: { type: 'list', value: page(start, n), total: 250, start },
    });
    const loaded = () => JSON.parse(screen.getByTestId('redis-value-viewer').getAttribute('data-value')!).value as string[];
    const send = (data: ExtensionMessage) => window.dispatchEvent(new MessageEvent('message', { data }));

    render(<RedisBrowser connectionId="conn1" database={0} />);
    send({ type: 'redisScanResult', scanned: 1000, requestId: lastScanId(), cursor: '0', done: true, keys: [{ key: 'l', type: 'list', ttl: -1 }] });
    await waitFor(() => screen.getByTestId('key-l').click());
    send(listResult(0, 100));
    await waitFor(() => screen.getByTestId('list-load-more').click());
    expect(mockPostMessage).toHaveBeenLastCalledWith({ type: 'redisGetValue', key: 'l', database: 0, listStart: 100 });
    send(listResult(100, 100));
    await waitFor(() => expect(loaded()).toHaveLength(200));

    // 写成功: 重拉首屏 (不带 listStart), 已加载的两页被首屏替换
    send({ type: 'redisOperationResult', success: true });
    await waitFor(() => expect(mockPostMessage).toHaveBeenLastCalledWith({ type: 'redisGetValue', key: 'l', database: 0 }));
    send(listResult(0, 100));
    await waitFor(() => expect(loaded()).toHaveLength(100));

    // 重拉前在途的第三页晚到: 接不上当前末尾, 丢弃
    send(listResult(200, 50));
    await new Promise((r) => setTimeout(r, 0));
    expect(loaded()).toHaveLength(100);

    screen.getByTestId('list-load-more').click();
    expect(mockPostMessage).toHaveBeenLastCalledWith({ type: 'redisGetValue', key: 'l', database: 0, listStart: 100 });
  });
});
