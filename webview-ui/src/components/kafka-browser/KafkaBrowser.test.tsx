import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { KafkaBrowser } from './KafkaBrowser';
import type { ExtensionMessage } from '../../types/messages';
import type { KafkaMessage, KafkaPartitionInfo } from '../../types/kafka';
import { mockPostMessage } from '../../__test__/setup';

vi.mock('../../styles/kafka-browser.css', () => ({}));

let topicProps: any;
let tableProps: any;
vi.mock('./KafkaTopicList', () => ({
  KafkaTopicList: (props: any) => { topicProps = props; return null; },
}));
vi.mock('./KafkaMessageTable', () => ({
  KafkaMessageTable: (props: any) => { tableProps = props; return null; },
}));

const send = (data: ExtensionMessage) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });

const partitions = (n: number): KafkaPartitionInfo[] =>
  Array.from({ length: n }, (_, i) => ({ partitionId: i, leader: 0, offset: '0' }));

const msg = (offset: string): KafkaMessage =>
  ({ partition: 0, offset, key: null, value: 'v', timestamp: '0', headers: {} });

describe('KafkaBrowser - 切 topic / partition 后旧回执丢弃', () => {
  it('旧 topic 的 partition 列表与消息晚到, 不显示在新 topic 下', () => {
    render(<KafkaBrowser connectionId="c1" />);
    act(() => { topicProps.onSelectTopic('A'); });
    send({ type: 'kafkaPartitionList', topic: 'A', partitions: partitions(3) });
    act(() => { tableProps.onFetch('0'); });
    act(() => { topicProps.onSelectTopic('B'); });

    send({ type: 'kafkaPartitionList', topic: 'A', partitions: partitions(3) });
    send({ type: 'kafkaMessageList', topic: 'A', partition: 0, messages: [msg('1')], timedOut: false });
    expect(tableProps.topic).toBe('B');
    expect(tableProps.partitions).toEqual([]);
    expect(tableProps.messages).toEqual([]);

    send({ type: 'kafkaPartitionList', topic: 'B', partitions: partitions(1) });
    expect(tableProps.partitions).toHaveLength(1);
  });

  it('换 partition 放弃进行中的拉取: 旧 partition 回执丢弃, Fetch 不再卡在 loading', () => {
    render(<KafkaBrowser connectionId="c1" />);
    act(() => { topicProps.onSelectTopic('A'); });
    send({ type: 'kafkaPartitionList', topic: 'A', partitions: partitions(2) });
    act(() => { tableProps.onFetch('0'); });
    expect(tableProps.loading).toBe(true);
    act(() => { tableProps.onPartitionChange(1); });
    expect(tableProps.loading).toBe(false);

    send({ type: 'kafkaMessageList', topic: 'A', partition: 0, messages: [msg('1')], timedOut: false });
    expect(tableProps.messages).toEqual([]);
  });
});

describe('KafkaBrowser - Latest / Refresh / 超时提示', () => {
  it('Latest 交给宿主现取 high watermark; 回执 timedOut 透传给表格; 两个 Refresh 重拉 topic 与 partition', () => {
    render(<KafkaBrowser connectionId="c1" />);
    act(() => { topicProps.onSelectTopic('A'); });
    send({ type: 'kafkaPartitionList', topic: 'A', partitions: partitions(2) });
    act(() => { tableProps.onPartitionChange(1); });
    mockPostMessage.mockClear();

    act(() => { tableProps.onFetchLatest(); });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'kafkaFetchLatest', topic: 'A', partition: 1, limit: 50 });
    expect(tableProps.loading).toBe(true);

    send({ type: 'kafkaMessageList', topic: 'A', partition: 1, messages: [], timedOut: true });
    expect(tableProps.loading).toBe(false);
    expect(tableProps.timedOut).toBe(true);

    act(() => { topicProps.onRefresh(); });
    act(() => { tableProps.onRefreshPartitions(); });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'kafkaListTopics' });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'kafkaGetPartitions', topic: 'A' });
  });
});
