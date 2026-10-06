import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { TableViewProvider } from './table-view-provider';
import type { ConnectionManager } from '../services/connection-manager';
import type { CredentialStore } from '../services/credential-store';

const { connectSpy, createTunnel } = vi.hoisted(() => ({
  connectSpy: vi.fn(async () => undefined),
  createTunnel: vi.fn(async () => ({ localPort: 4000, close: () => {} })),
}));
vi.mock('../drivers/mysql-driver', () => ({
  MySQLDriver: class { connect = connectSpy; disconnect = vi.fn(async () => undefined); },
}));
vi.mock('../services/ssh-tunnel', () => ({ createTunnel, KNOWN_HOSTS_PATH: '/tmp/known_hosts' }));

describe('TableViewProvider panel 标题', () => {
  it('Query / DDL / Edit 标题带连接名, 不同环境的同名库能分开', async () => {
    const create = vi.spyOn(vscode.window, 'createWebviewPanel').mockClear();
    const cm = {
      getConnections: () => [{ id: 'c1', name: 'release' }],
      getDriver: () => ({ driverType: 'mysql', getTableDDL: async () => 'CREATE TABLE t (id int)' }),
    } as unknown as ConnectionManager;
    const provider = new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore);

    provider.openQueryEditor('c1', 'game');
    provider.showTableDDL('c1', 'game', 'player');
    provider.openEditTable('c1', 'game', 'player');

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(create.mock.calls.map((c) => c[1]).sort()).toEqual([
      'DDL - release/game.player',
      'Edit - release/game.player',
      'Query - release/game',
    ]);
  });
});

// 记下 panel 的消息处理器与发往 webview 的消息; send 等处理器跑完, close 模拟用户关掉 panel
function fakePanel() {
  const handlers: Array<(m: unknown) => unknown> = [];
  const posted: Array<Record<string, unknown>> = [];
  const onClose: Array<() => void> = [];
  const panel = {
    webview: {
      html: '',
      onDidReceiveMessage: (h: (m: unknown) => unknown) => {
        handlers.push(h);
        return { dispose: () => { const i = handlers.indexOf(h); if (i >= 0) { handlers.splice(i, 1); } } };
      },
      postMessage: async (m: Record<string, unknown>) => { posted.push(m); return true; },
      asWebviewUri: (u: unknown) => u,
      cspSource: '',
    },
    onDidDispose: (cb: () => void) => { onClose.push(cb); return { dispose: () => {} }; },
    reveal: () => {},
    dispose: vi.fn(),
  };
  const send = async (m: object) => { for (const h of [...handlers]) { await h(m); } };
  const close = () => { for (const cb of onClose) { cb(); } };
  return { panel, posted, send, close, handlers };
}

describe('TableViewProvider panel 生命周期', () => {
  it('每次 ready 都回 viewInit (Reload Webviews 后重新握手); panel 关闭时注销消息监听', async () => {
    const fake = fakePanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const cm = { getConnections: () => [{ id: 'c1', name: 'release' }], getDriver: () => ({ driverType: 'mysql' }) } as unknown as ConnectionManager;
    new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore).openQueryEditor('c1', 'game');

    await fake.send({ type: 'ready' });
    await fake.send({ type: 'ready' });
    expect(fake.posted.filter((m) => m.type === 'viewInit')).toHaveLength(2);

    fake.close();
    expect(fake.handlers).toHaveLength(0);
  });
});

describe('TableViewProvider schema 缓存', () => {
  const columns = [
    { table: 't', name: 'id', type: 'int', comment: '' },
    { table: 't', name: 'v', type: 'varchar(8)', comment: 'value' },
  ];
  const listSchemaColumns = vi.fn(async () => columns);
  let driver: object;
  const cm = {
    getConnections: () => [{ id: 'c1', name: 'release' }],
    getState: () => 'connected',
    getDriver: () => driver,
  } as unknown as ConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    driver = { driverType: 'mysql', listSchemaColumns };
  });

  it('多个 panel 同时冷启动共用一次查询; Refresh Schema 与重连 (新 driver) 后重新查; 失败不缓存', async () => {
    const a = fakePanel();
    const b = fakePanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValueOnce(a.panel as never).mockReturnValueOnce(b.panel as never);
    const provider = new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore);
    provider.openQueryEditor('c1', 'game');
    provider.openQueryEditor('c1', 'game');

    await Promise.all([a.send({ type: 'requestSchema', database: 'game' }), b.send({ type: 'requestSchema', database: 'game' })]);
    expect(listSchemaColumns).toHaveBeenCalledTimes(1);
    expect(listSchemaColumns).toHaveBeenCalledWith('game');
    expect(a.posted).toContainEqual({ type: 'schemaInfo', schema: { t: ['id', 'v'] } });
    expect(b.posted).toContainEqual({ type: 'schemaInfo', schema: { t: ['id', 'v'] } });

    await a.send({ type: 'refreshSchema', database: 'game' });
    expect(listSchemaColumns).toHaveBeenCalledTimes(2);

    driver = { driverType: 'mysql', listSchemaColumns };
    listSchemaColumns.mockRejectedValueOnce(new Error('gone'));
    await b.send({ type: 'requestSchema', database: 'game' });
    expect(b.posted).toContainEqual({ type: 'error', message: 'gone' });
    await b.send({ type: 'requestSchema', database: 'game' });
    expect(listSchemaColumns).toHaveBeenCalledTimes(4);
  });
});

describe('TableViewProvider 只读连接', () => {
  const executeBatch = vi.fn(() => ({ promise: Promise.resolve({ results: [] }), cancel: () => {} }));
  const getDriver = vi.fn(() => ({ driverType: 'mysql', executeBatch }));
  const getRedisDriver = vi.fn();
  const cm = {
    getConnections: () => [{ id: 'ro', name: 'release', readOnly: true }],
    getState: () => 'connected',
    getDriver,
    getRedisDriver,
  } as unknown as ConnectionManager;
  let fake: ReturnType<typeof fakePanel>;
  let create: ReturnType<typeof vi.spyOn>;
  let showError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = fakePanel();
    create = vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    showError = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
  });

  it('标题带 (read-only), viewInit context 带 readOnly 供 webview 隐藏写控件', async () => {
    new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore).openQueryEditor('ro', 'game');
    await fake.send({ type: 'ready' });

    expect(create.mock.calls[0][1]).toBe('Query - release/game (read-only)');
    expect(fake.posted.find((m) => m.type === 'viewInit')?.context).toMatchObject({ connectionId: 'ro', readOnly: true });
  });

  it('写消息在宿主拒绝: 回失败回执并提示, 不碰 driver', async () => {
    new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore).openQueryEditor('ro', 'game');
    getDriver.mockClear();
    await fake.send({ type: 'batchUpdate', database: 'game', table: 't', updates: [] });

    expect(fake.posted).toContainEqual({ type: 'batchUpdateResult', success: false, error: 'Connection release is read-only' });
    expect(showError).toHaveBeenCalledWith('Connection release is read-only');
    expect(getDriver).not.toHaveBeenCalled();
  });

  it('Redis 命令栏的写命令: 拒绝写进命令输出, 不弹提示', async () => {
    new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore).openQueryEditor('ro', 'game');
    await fake.send({ type: 'redisExecuteCommand', command: 'DEL k', database: 0 });

    expect(fake.posted).toContainEqual({ type: 'redisCommandResult', output: '(error) Connection release is read-only: DEL is not a read command' });
    expect(showError).not.toHaveBeenCalled();
    expect(getRedisDriver).not.toHaveBeenCalled();
  });

  it('编辑器执行照常放行, 跑在只读会话里', async () => {
    new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore).openQueryEditor('ro', 'game');
    await fake.send({ type: 'executeQuery', requestId: 1, database: 'game', sql: 'SELECT 1' });

    expect(executeBatch).toHaveBeenCalledWith(['SELECT 1'], 'game', { readOnly: true });
  });
});

describe('TableViewProvider 编辑连接表单不经手明文密码', () => {
  const config = {
    id: 'c1', name: 'release', driverType: 'mysql', host: 'db', port: 3306, username: 'root', database: 'game',
    ssh: { enabled: true, host: 'jump', port: 22, username: 'ops', authType: 'password' },
  };
  const credentials = {
    getPassword: vi.fn(async () => 'db-pw'),
    getSSHPassword: vi.fn(async () => 'ssh-pw'),
  } as unknown as CredentialStore;
  const updateConnection = vi.fn(async () => undefined);
  const cm = {
    getConnections: () => [config], getState: () => 'connected', updateConnection, getDriver: () => ({ driverType: 'mysql' }),
  } as unknown as ConnectionManager;
  const formFields = {
    driverType: 'mysql', host: 'db', port: 3306, username: 'root', password: '', database: 'game',
    sshEnabled: true, sshHost: 'jump', sshPort: 22, sshUsername: 'ops', sshAuthType: 'password', sshPassword: '', sshPrivateKeyPath: '',
  };
  let fake: ReturnType<typeof fakePanel>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = fakePanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
  });

  async function openEditForm(provider = new TableViewProvider(vscode.Uri.file('/ext'), cm, credentials)) {
    provider.openConnectionForm('c1');
    await vi.waitFor(() => expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('sqlext.webview', 'Edit Connection', expect.anything(), expect.anything()));
    await fake.send({ type: 'ready' });
  }

  it('表单只拿到 hasPassword / hasSshPassword', async () => {
    await openEditForm();
    const init = fake.posted.find((m) => m.type === 'viewInit');
    expect((init?.context as { editConnection: object }).editConnection).toMatchObject({ hasPassword: true, hasSshPassword: true });
    expect(JSON.stringify(init)).not.toMatch(/db-pw|ssh-pw/);
  });

  it('Test Connection 留空的密码用已存值 (DB 与 SSH)', async () => {
    await openEditForm();
    await fake.send({ type: 'testConnection', config: formFields });

    expect(createTunnel).toHaveBeenCalledWith(expect.objectContaining({ host: 'jump' }), 'ssh-pw', 'db', 3306, expect.anything());
    expect(connectSpy).toHaveBeenCalledWith(expect.objectContaining({ password: 'db-pw', host: '127.0.0.1', port: 4000 }));
    expect(fake.posted).toContainEqual({ type: 'connectionTestResult', success: true });
  });

  it('保存: 留空的密码交给 updateConnection 表示保留, 填了的替换', async () => {
    await openEditForm();
    await fake.send({ type: 'updateConnection', config: { ...formFields, id: 'c1', name: 'release', readOnly: true } });
    await fake.send({ type: 'updateConnection', config: { ...formFields, id: 'c1', name: 'release', readOnly: false, password: 'new-pw' } });

    expect(updateConnection.mock.calls[0]).toEqual(['c1', expect.objectContaining({ readOnly: true }), undefined, undefined]);
    expect(updateConnection.mock.calls[1]).toEqual(['c1', expect.objectContaining({ readOnly: false }), 'new-pw', undefined]);
  });

  it('非编辑表单的 panel 发 updateConnection 不处理: 不能借消息里的 id 把已存密码指向别的 host', async () => {
    new TableViewProvider(vscode.Uri.file('/ext'), cm, credentials).openQueryEditor('c1', 'game');
    await fake.send({ type: 'updateConnection', config: { ...formFields, id: 'c1', name: 'release', host: 'evil' } });

    expect(updateConnection).not.toHaveBeenCalled();
  });

  it('只读开关变了才关掉该连接已开的 panel, 重开按新配置生成', async () => {
    const query = fakePanel();
    const other = fakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(query.panel as never).mockReturnValueOnce(other.panel as never);
    const provider = new TableViewProvider(vscode.Uri.file('/ext'), cm, credentials);
    provider.openQueryEditor('c1', 'game');
    provider.openQueryEditor('c10', 'game');
    await openEditForm(provider);

    await fake.send({ type: 'updateConnection', config: { ...formFields, id: 'c1', name: 'release', readOnly: false } });
    expect(query.panel.dispose).not.toHaveBeenCalled();

    await fake.send({ type: 'updateConnection', config: { ...formFields, id: 'c1', name: 'release', readOnly: true } });
    expect(query.panel.dispose).toHaveBeenCalled();
    expect(other.panel.dispose).not.toHaveBeenCalled();
  });
});

describe('TableViewProvider 连接掉线后按需重连', () => {
  const executeBatch = vi.fn(() => ({ promise: Promise.resolve({ results: [] }), cancel: () => {} }));
  let state: string;
  const connect = vi.fn(async () => { state = 'connected'; });
  const cm = {
    getConnections: () => [{ id: 'c1', name: 'release' }],
    getState: () => state,
    connect,
    getDriver: vi.fn(() => ({ driverType: 'mysql', executeBatch })),
  } as unknown as ConnectionManager;
  let fake: ReturnType<typeof fakePanel>;

  beforeEach(() => {
    vi.clearAllMocks();
    state = 'disconnected';
    fake = fakePanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore).openQueryEditor('c1', 'game');
  });

  it('掉线后的下一条消息先连上再处理; 不碰库的消息不触发重连', async () => {
    await fake.send({ type: 'cancelQuery' });
    expect(connect).not.toHaveBeenCalled();

    await fake.send({ type: 'executeQuery', requestId: 1, database: 'game', sql: 'SELECT 1' });
    expect(connect).toHaveBeenCalledWith('c1');
    expect(executeBatch).toHaveBeenCalled();
    expect(fake.posted).toContainEqual(expect.objectContaining({ type: 'queryBatchResult', requestId: 1 }));
  });

  it('重连失败回可见的 error, 不往下处理', async () => {
    connect.mockRejectedValueOnce(new Error('SSH tunnel ops@jump:22 failed: Timed out while waiting for handshake'));
    await fake.send({ type: 'executeQuery', requestId: 1, database: 'game', sql: 'SELECT 1' });

    expect(fake.posted).toContainEqual({
      type: 'error', message: 'Failed to connect: SSH tunnel ops@jump:22 failed: Timed out while waiting for handshake',
    });
    expect(executeBatch).not.toHaveBeenCalled();
  });
});
