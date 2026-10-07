import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MongoBrowser, isPathProjection } from './MongoBrowser';
import { mockPostMessage } from '../../__test__/setup';
import type { ExtensionMessage } from '../../../../src/types/messages';

vi.mock('../../styles/mongo-browser.css', () => ({}));

let listProps: any;
vi.mock('./MongoCollectionList', () => ({
  MongoCollectionList: (props: any) => { listProps = props; return null; },
}));

// 捕获最近一次传给 MongoDocumentTable 的 props
let tableProps: any;
vi.mock('./MongoDocumentTable', () => ({
  MongoDocumentTable: (props: any) => { tableProps = props; return null; },
}));

const send = (data: ExtensionMessage) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });

// 回执须带回最近一次 mongoFindDocuments 的 requestId 才会被采用
const lastFindId = (): number =>
  [...mockPostMessage.mock.calls].reverse().find(([m]) => m.type === 'mongoFindDocuments')![0].requestId;

const docList = (): ExtensionMessage =>
  ({ type: 'mongoDocumentList', requestId: lastFindId(), columns: [], rows: [{ _id: 1, name: 'a' }] });

const lastSent = (type: string): any =>
  [...mockPostMessage.mock.calls].reverse().find(([m]) => m.type === type)?.[0];

// 打开 users 集合并让首屏回包到达
function openUsers() {
  render(<MongoBrowser connectionId="c1" defaultDatabase="db" />);
  send({ type: 'mongoAllCollectionList', collections: [{ database: 'db', name: 'users', count: 1 }] });
  send(docList());
}

function applyQuery(fields: { filter?: string; sort?: string; projection?: string; limit?: string; skip?: string }) {
  act(() => {
    if (fields.filter !== undefined) { tableProps.onFilterChange(fields.filter); }
    if (fields.sort !== undefined) { tableProps.onSortChange(fields.sort); }
    if (fields.projection !== undefined) { tableProps.onProjectionChange(fields.projection); }
    if (fields.limit !== undefined) { tableProps.onLimitChange(fields.limit); }
    if (fields.skip !== undefined) { tableProps.onSkipChange(fields.skip); }
  });
  act(() => { tableProps.onApply(); });
}

describe('MongoBrowser - 已生效查询的快照', () => {
  it('翻页 / 刷新 / Explain / Export 按 Apply 时的条件, 不读之后输入框里未 Apply 的文本; 偏移含 Skip', () => {
    openUsers();
    applyQuery({ filter: '{"a": 1}', sort: '{"b": -1}', projection: '{"a": 1}', limit: '10', skip: '100' });
    expect(lastSent('mongoFindDocuments')).toMatchObject({ filter: '{"a": 1}', sort: '{"b": -1}', projection: '{"a": 1}', skip: 100, limit: 10, count: true });
    send(docList());

    // 改了输入但没 Apply
    act(() => { tableProps.onFilterChange('{"typed": 1}'); tableProps.onSkipChange('0'); tableProps.onLimitChange('3'); });
    act(() => { tableProps.onPageChange(1); });
    expect(lastSent('mongoFindDocuments')).toMatchObject({ filter: '{"a": 1}', skip: 110, limit: 10, count: false });
    expect(tableProps).toMatchObject({ page: 1, offset: 110, pageSize: 10 });

    // 写操作 / 导入成功后的刷新留在当前页, 并重算总数 (文档数变了), 新总数被采用
    send({ type: 'mongoOperationResult', success: true });
    expect(lastSent('mongoFindDocuments')).toMatchObject({ filter: '{"a": 1}', skip: 110, limit: 10, count: true });
    send({ type: 'mongoImportResult', success: true, inserted: 3 });
    expect(lastSent('mongoFindDocuments')).toMatchObject({ skip: 110, count: true });
    // 导入中途失败时前面的批次可能已落库, 同样刷新
    const beforeFailedImport = lastFindId();
    send({ type: 'mongoImportResult', success: false, error: 'Imported 500 of 900 documents before the error: E11000' });
    expect(lastFindId()).toBeGreaterThan(beforeFailedImport);
    expect(lastSent('mongoFindDocuments')).toMatchObject({ skip: 110, count: true });
    expect(tableProps.total).toBeNull();
    send({ type: 'mongoDocumentCount', requestId: lastFindId(), total: 1003 });
    expect(tableProps).toMatchObject({ total: 1003, page: 1, offset: 110 });

    act(() => { tableProps.onExplain(); });
    expect(lastSent('mongoExplainQuery')).toMatchObject({ filter: '{"a": 1}', sort: '{"b": -1}' });
    act(() => { tableProps.onExport(); });
    expect(lastSent('mongoExportCollection')).toMatchObject({ filter: '{"a": 1}', sort: '{"b": -1}', projection: '{"a": 1}' });
  });

  it('总数按 Apply 那次查询认领: 翻页后到达仍采用, 过期的丢弃; 未知时为 null', () => {
    openUsers();
    const firstFind = lastFindId();
    applyQuery({ filter: '{"a": 1}' });
    const applyFind = lastFindId();
    expect(tableProps.total).toBeNull();
    act(() => { tableProps.onPageChange(1); });

    send({ type: 'mongoDocumentCount', requestId: firstFind, total: 999 });
    expect(tableProps.total).toBeNull();
    send({ type: 'mongoDocumentCount', requestId: applyFind, total: 120 });
    expect(tableProps.total).toBe(120);
    send({ type: 'mongoDocumentCount', requestId: applyFind, total: null });
    expect(tableProps.total).toBeNull();
  });

  it('切集合: 查询复位并重新计数, 关掉上一个集合的 explain, 上一个集合的行不留在新集合名下', () => {
    render(<MongoBrowser connectionId="c1" defaultDatabase="db" />);
    send({ type: 'mongoAllCollectionList', collections: [
      { database: 'db', name: 'users', count: 1 }, { database: 'db', name: 'orders', count: 1 },
    ] });
    applyQuery({ filter: '{"a": 1}', skip: '5' });
    send(docList());
    expect(tableProps.rows).toHaveLength(1);
    act(() => { tableProps.onExplain(); });
    send({ type: 'mongoExplainResult', summary: { stage: 'COLLSCAN', isCollScan: true } });
    expect(tableProps.explain).not.toBeNull();

    act(() => { listProps.onSelectCollection('db', 'orders'); });
    act(() => { tableProps.onSwitchConfirmed(); });
    expect(tableProps.explain).toBeNull();
    expect(tableProps).toMatchObject({ collection: 'orders', rows: [], loading: true });
    // 切走前发出的 explain 迟到: 面板已关, 不再显示旧集合的执行计划
    send({ type: 'mongoExplainResult', summary: { stage: 'IXSCAN', isCollScan: false } });
    expect(tableProps.explain).toBeNull();
    expect(lastSent('mongoFindDocuments')).toMatchObject({ collection: 'orders', filter: '', skip: 0, limit: 50, count: true });
    expect(tableProps).toMatchObject({ filter: '', offset: 0 });
  });

  it('Limit 最多 200; Apply 关掉上一条查询的 explain', () => {
    openUsers();
    act(() => { tableProps.onExplain(); });
    send({ type: 'mongoExplainResult', summary: { stage: 'COLLSCAN', isCollScan: true } });
    expect(tableProps.explain).not.toBeNull();
    applyQuery({ limit: '1000' });
    expect(lastSent('mongoFindDocuments')).toMatchObject({ limit: 200, skip: 0 });
    // 输入框回显实际生效的上限
    expect(tableProps.customLimit).toBe('200');
    expect(tableProps.explain).toBeNull();
    send(docList());
    act(() => { tableProps.onPageChange(1); });
    expect(lastSent('mongoFindDocuments')).toMatchObject({ limit: 200, skip: 200 });
  });

  it('readOnly 跟随已生效的 projection: 顶层字段取舍可编辑, 子路径 / 表达式只读', () => {
    openUsers();
    expect(tableProps.readOnly).toBe(false);
    applyQuery({ projection: '{"name": 1, "bag": 1}' });
    expect(tableProps.readOnly).toBe(false);
    // 子文档数组 items 的每个元素会被裁成只剩 name, 写回整组 $set 会丢掉其余子字段
    applyQuery({ projection: '{"items.name": 1}' });
    expect(tableProps.readOnly).toBe(true);
    applyQuery({ projection: '{"name": "$nickname"}' });
    expect(tableProps.readOnly).toBe(true);
    // 输入改了但没 Apply 不影响
    act(() => { tableProps.onProjectionChange(''); });
    expect(tableProps.readOnly).toBe(true);
  });
});

describe('isPathProjection', () => {
  it('只有顶层字段且值都是 0/1/true/false 才算可写回的取舍 (mongosh 裸 key / 单引号同样认)', () => {
    for (const p of ['', '{}', '{"a": 1, "b": 0}', '{"a": true}', '{"_id": 0, "a": 1}', '{name: 1, _id: 0}', "{'bag': 1}"]) {
      expect(isPathProjection(p)).toBe(true);
    }
    for (const p of ['{"items.name": 1}', '{"items.qty": 0}', '{"bag": {"gold": 1}}', '{"a": "$b"}',
      '{"items": {"$slice": ["$items", 2]}}', '{"t": {"$add": ["$a", 1]}}', '{"a": [1]}', '{"a": null}', '[1]', 'not json', "{'bag.gold': 1}", "{n: '$name'}"]) {
      expect(isPathProjection(p)).toBe(false);
    }
  });
});

describe('MongoBrowser - 查询历史', () => {
  it('Apply 的回执无 error 才记录; 历史带集合名, 只给当前集合的条目', () => {
    render(<MongoBrowser connectionId="c1" defaultDatabase="db" />);
    send({ type: 'mongoAllCollectionList', collections: [
      { database: 'db', name: 'users', count: 1 }, { database: 'db', name: 'orders', count: 1 },
    ] });
    send(docList());

    applyQuery({ filter: '{uid: 1' });
    send({ type: 'mongoDocumentList', requestId: lastFindId(), columns: [], rows: [], error: 'Filter: bad' });
    expect(tableProps.history).toEqual([]);

    applyQuery({ filter: '{uid: 1}' });
    // 翻页的回执不认领 Apply 的那条历史
    act(() => { tableProps.onPageChange(1); });
    send(docList());
    expect(tableProps.history).toEqual([]);
    applyQuery({ filter: '{uid: 1}', sort: '{lv: -1}' });
    send(docList());
    expect(tableProps.history).toMatchObject([{ namespace: 'db.users', filter: '{uid: 1}', sort: '{lv: -1}' }]);

    act(() => { listProps.onSelectCollection('db', 'orders'); });
    act(() => { tableProps.onSwitchConfirmed(); });
    send(docList());
    expect(tableProps.history).toEqual([]);
  });
});

describe('MongoBrowser - 打开时的初选集合与刷新列表', () => {
  const collections = [
    { database: 'act', name: 'act_arena_50', count: 9 },
    { database: 'game', name: 'players', count: 3 },
    { database: 'game', name: 'zones', count: 1 },
  ];

  it('有连接配置的 database: 选中它的第一个集合, 不碰别的库', () => {
    render(<MongoBrowser connectionId="c1" defaultDatabase="game" />);
    send({ type: 'mongoAllCollectionList', collections });
    expect(lastSent('mongoFindDocuments')).toMatchObject({ database: 'game', collection: 'players' });
    expect(listProps.selected).toEqual({ database: 'game', name: 'players' });
  });

  it('没配 database: 不选中也不查询, 提示去选集合', () => {
    render(<MongoBrowser connectionId="c1" />);
    send({ type: 'mongoAllCollectionList', collections });
    expect(lastSent('mongoFindDocuments')).toBeUndefined();
    expect(listProps.selected).toBeNull();
    expect(screen.getByText('Select a collection to browse documents')).toBeInTheDocument();

    // 没有选中时表格未挂载, 点集合直接切过去
    act(() => { listProps.onSelectCollection('game', 'zones'); });
    expect(lastSent('mongoFindDocuments')).toMatchObject({ database: 'game', collection: 'zones' });
    expect(listProps.selected).toEqual({ database: 'game', name: 'zones' });
  });

  it('Refresh 重新拉集合列表 (计数随之更新), 不改当前选中', () => {
    render(<MongoBrowser connectionId="c1" defaultDatabase="game" />);
    send({ type: 'mongoAllCollectionList', collections });
    mockPostMessage.mockClear();
    act(() => { listProps.onRefresh(); });
    expect(mockPostMessage.mock.calls).toEqual([[{ type: 'mongoListAllCollections' }]]);
    expect(listProps.loading).toBe(true);
    send({ type: 'mongoAllCollectionList', collections: [{ ...collections[0] }, { ...collections[1], count: 19919 }, collections[2]] });
    expect(listProps.loading).toBe(false);
    expect(listProps.collections[1].count).toBe(19919);
    expect(listProps.selected).toEqual({ database: 'game', name: 'players' });
    expect(lastSent('mongoFindDocuments')).toBeUndefined();
  });
});

describe('MongoBrowser - 切集合后旧查询的回执丢弃', () => {
  it('慢的 users 回执晚于 orders 请求到达, 不顶替 orders 的行', () => {
    render(<MongoBrowser connectionId="c1" defaultDatabase="db" />);
    send({ type: 'mongoAllCollectionList', collections: [
      { database: 'db', name: 'users', count: 1 }, { database: 'db', name: 'orders', count: 1 },
    ] });
    const usersFind = lastFindId();
    act(() => { listProps.onSelectCollection('db', 'orders'); });
    act(() => { tableProps.onSwitchConfirmed(); });
    expect(tableProps.collection).toBe('orders');

    send({ type: 'mongoDocumentList', requestId: usersFind, columns: [], rows: [{ _id: 1, from: 'users' }] });
    expect(tableProps.rows).toEqual([]);
    expect(tableProps.loading).toBe(true);

    send({ type: 'mongoDocumentList', requestId: lastFindId(), columns: [], rows: [{ _id: 1, from: 'orders' }] });
    expect(tableProps.rows).toEqual([{ _id: 1, from: 'orders' }]);
    expect(tableProps.loading).toBe(false);
  });
});

describe('MongoBrowser - 写失败可见', () => {
  it('写失败行内显示 (不用 alert), 把失败回执交给编辑器保留草稿; 下次取数清掉', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    openUsers();
    send({ type: 'mongoOperationResult', success: false, error: 'E11000 duplicate key error' });

    expect(screen.getByRole('alert')).toHaveTextContent('Operation failed: E11000 duplicate key error');
    expect(tableProps.writeResult).toEqual({ ok: false });
    expect(alertSpy).not.toHaveBeenCalled();

    act(() => { tableProps.onApply(); });
    expect(screen.queryByRole('alert')).toBeNull();
    alertSpy.mockRestore();
  });

  it('笼统 error 结束挂起的 explain spinner, 已出结果的 explain 保留', () => {
    openUsers();
    act(() => { tableProps.onExplain(); });
    expect(tableProps.explain).toEqual({ loading: true });
    send({ type: 'error', message: 'Failed to connect: x' });
    expect(tableProps.explain).toBeNull();

    act(() => { tableProps.onExplain(); });
    send({ type: 'mongoExplainResult', summary: { stage: 'IXSCAN', isCollScan: false } });
    send({ type: 'error', message: 'Failed to connect: x' });
    expect(tableProps.explain).toMatchObject({ summary: { stage: 'IXSCAN' } });
  });
});
