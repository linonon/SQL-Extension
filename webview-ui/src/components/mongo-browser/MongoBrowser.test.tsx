import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MongoBrowser } from './MongoBrowser';
import type { ExtensionMessage } from '../../types/messages';

vi.mock('../../styles/mongo-browser.css', () => ({}));
vi.mock('./MongoCollectionList', () => ({ MongoCollectionList: () => null }));

// 捕获最近一次传给 MongoDocumentTable 的 props
let tableProps: any;
vi.mock('./MongoDocumentTable', () => ({
  MongoDocumentTable: (props: any) => { tableProps = props; return null; },
}));

const send = (data: ExtensionMessage) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });

const docList: ExtensionMessage = { type: 'mongoDocumentList', columns: [], rows: [{ _id: 1, name: 'a' }], total: 1 };

describe('MongoBrowser - projected 跟随已生效的查询', () => {
  it('回包到达才生效; 输入框改了未 Apply 不影响', () => {
    render(<MongoBrowser connectionId="c1" />);
    send({ type: 'mongoAllCollectionList', collections: [{ database: 'db', name: 'users', count: 1 }] });
    send(docList);
    expect(tableProps.projected).toBe(false);

    act(() => { tableProps.onProjectionChange('{ name: 1 }'); });
    act(() => { tableProps.onApply(); });
    expect(tableProps.projected).toBe(false);
    send(docList);
    expect(tableProps.projected).toBe(true);

    // 清空输入但没 Apply: 当前 rows 仍是投影结果
    act(() => { tableProps.onProjectionChange(''); });
    expect(tableProps.projected).toBe(true);
    act(() => { tableProps.onApply(); });
    send(docList);
    expect(tableProps.projected).toBe(false);
  });
});
