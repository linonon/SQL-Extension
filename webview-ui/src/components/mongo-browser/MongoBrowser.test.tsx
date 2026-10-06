import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MongoBrowser, isPathProjection } from './MongoBrowser';
import { mockPostMessage } from '../../__test__/setup';
import type { ExtensionMessage } from '../../types/messages';

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
  render(<MongoBrowser connectionId="c1" />);
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

  it('切集合: 查询复位并重新计数, 关掉上一个集合的 explain', () => {
    render(<MongoBrowser connectionId="c1" />);
    send({ type: 'mongoAllCollectionList', collections: [
      { database: 'db', name: 'users', count: 1 }, { database: 'db', name: 'orders', count: 1 },
    ] });
    applyQuery({ filter: '{"a": 1}', skip: '5' });
    act(() => { tableProps.onExplain(); });
    send({ type: 'mongoExplainResult', summary: { stage: 'COLLSCAN', isCollScan: true } });
    expect(tableProps.explain).not.toBeNull();

    act(() => { listProps.onSelectCollection('db', 'orders'); });
    act(() => { tableProps.onSwitchConfirmed(); });
    expect(tableProps.explain).toBeNull();
    // 切走前发出的 explain 迟到: 面板已关, 不再显示旧集合的执行计划
    send({ type: 'mongoExplainResult', summary: { stage: 'IXSCAN', isCollScan: false } });
    expect(tableProps.explain).toBeNull();
    expect(lastSent('mongoFindDocuments')).toMatchObject({ collection: 'orders', filter: '', skip: 0, limit: 50, count: true });
    expect(tableProps).toMatchObject({ filter: '', offset: 0 });
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
  it('只有顶层字段且值都是 0/1/true/false 才算可写回的取舍', () => {
    for (const p of ['', '{}', '{"a": 1, "b": 0}', '{"a": true}', '{"_id": 0, "a": 1}']) {
      expect(isPathProjection(p)).toBe(true);
    }
    for (const p of ['{"items.name": 1}', '{"items.qty": 0}', '{"bag": {"gold": 1}}', '{"a": "$b"}',
      '{"items": {"$slice": ["$items", 2]}}', '{"t": {"$add": ["$a", 1]}}', '{"a": [1]}', '{"a": null}', '[1]', 'not json']) {
      expect(isPathProjection(p)).toBe(false);
    }
  });
});

describe('MongoBrowser - 切集合后旧查询的回执丢弃', () => {
  it('慢的 users 回执晚于 orders 请求到达, 不顶替 orders 的行', () => {
    render(<MongoBrowser connectionId="c1" />);
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
