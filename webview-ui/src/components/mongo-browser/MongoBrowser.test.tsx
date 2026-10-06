import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MongoBrowser } from './MongoBrowser';
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
  ({ type: 'mongoDocumentList', requestId: lastFindId(), columns: [], rows: [{ _id: 1, name: 'a' }], total: 1 });

describe('MongoBrowser - projected 跟随已生效的查询', () => {
  it('回包到达才生效; 输入框改了未 Apply 不影响', () => {
    render(<MongoBrowser connectionId="c1" />);
    send({ type: 'mongoAllCollectionList', collections: [{ database: 'db', name: 'users', count: 1 }] });
    send(docList());
    expect(tableProps.projected).toBe(false);

    act(() => { tableProps.onProjectionChange('{ name: 1 }'); });
    act(() => { tableProps.onApply(); });
    expect(tableProps.projected).toBe(false);
    send(docList());
    expect(tableProps.projected).toBe(true);

    // 清空输入但没 Apply: 当前 rows 仍是投影结果
    act(() => { tableProps.onProjectionChange(''); });
    expect(tableProps.projected).toBe(true);
    act(() => { tableProps.onApply(); });
    send(docList());
    expect(tableProps.projected).toBe(false);
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

    send({ type: 'mongoDocumentList', requestId: usersFind, columns: [], rows: [{ _id: 1, from: 'users' }], total: 1 });
    expect(tableProps.rows).toEqual([]);
    expect(tableProps.loading).toBe(true);

    send({ type: 'mongoDocumentList', requestId: lastFindId(), columns: [], rows: [{ _id: 1, from: 'orders' }], total: 1 });
    expect(tableProps.rows).toEqual([{ _id: 1, from: 'orders' }]);
    expect(tableProps.loading).toBe(false);
  });
});
