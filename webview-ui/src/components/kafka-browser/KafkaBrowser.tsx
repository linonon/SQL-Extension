import { useCallback, useEffect, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage, WebviewMessage } from '../../types/messages';
import type { KafkaTopicInfo, KafkaPartitionInfo, KafkaMessage } from '../../types/kafka';
import { KafkaTopicList } from './KafkaTopicList';
import { KafkaMessageTable } from './KafkaMessageTable';
import '../../styles/kafka-browser.css';

interface KafkaBrowserProps {
  readonly connectionId: string;
}

export function KafkaBrowser({ connectionId }: KafkaBrowserProps) {
  const [topics, setTopics] = useState<readonly KafkaTopicInfo[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [partitions, setPartitions] = useState<readonly KafkaPartitionInfo[]>([]);
  const [selectedPartition, setSelectedPartition] = useState(0);
  const [messages, setMessages] = useState<readonly KafkaMessage[]>([]);
  const [loading, setLoading] = useState(false);
  // 最近一次拉取在加入 group 后等满超时仍没收到消息
  const [timedOut, setTimedOut] = useState(false);
  const [panelWidth, setPanelWidth] = useState(240);
  const [produceResult, setProduceResult] = useState<{ readonly success: boolean; readonly partition?: number; readonly offset?: string; readonly error?: string } | null>(null);
  // 最近一次 topic / partition / 消息请求的失败原因; 发新请求时清掉
  const [error, setError] = useState<string | null>(null);

  const postMessage = usePostMessage();
  const request = useCallback((message: WebviewMessage) => {
    setError(null);
    postMessage(message);
  }, [postMessage]);
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    switch (msg.type) {
      case 'kafkaTopicList':
        if (msg.error) { setError(msg.error); break; }
        setTopics(msg.topics);
        break;
      // 回执带回 topic / partition, 与当前选中的对不上就是切换前的旧请求晚到, 丢弃 (否则显示在新 topic 标题下)
      case 'kafkaPartitionList':
        if (msg.topic !== selectedTopic) { break; }
        if (msg.error) { setError(msg.error); setLoading(false); break; }
        setPartitions((prev) => {
          // 如果是刷新 (partition 数量不变), 保留当前选中和消息列表
          if (prev.length > 0 && prev.length === msg.partitions.length) {
            return msg.partitions;
          }
          // 首次加载或 partition 变化, reset
          setSelectedPartition(msg.partitions.length > 0 ? msg.partitions[0].partitionId : 0);
          setMessages([]);
          setTimedOut(false);
          setLoading(false);
          return msg.partitions;
        });
        break;
      case 'kafkaMessageList':
        if (msg.topic !== selectedTopic || msg.partition !== selectedPartition) { break; }
        setMessages(msg.messages);
        setTimedOut(msg.timedOut);
        setLoading(false);
        if (msg.error) { setError(msg.error); }
        break;
      case 'kafkaProduceResult':
        setProduceResult({ success: msg.success, partition: msg.partition, offset: msg.offset, error: msg.error });
        if (msg.success && selectedTopic) {
          postMessage({ type: 'kafkaGetPartitions', topic: selectedTopic });
        }
        break;
      // 笼统失败 (如按需重连失败) 由 App 显示, 这里只结束 loading 与挂起的发送 (不带 error 的失败结果只解除 Sending)
      case 'error':
        setLoading(false);
        setProduceResult((prev) => prev ?? { success: false });
        break;
    }
  }, [selectedTopic, selectedPartition, postMessage]);

  useVSCodeMessage(handleMessage);

  // 初始加载 topics
  useEffect(() => {
    request({ type: 'kafkaListTopics' });
  }, [request]);

  // 选中 topic 时加载 partitions
  useEffect(() => {
    if (selectedTopic) {
      setPartitions([]);
      setMessages([]);
      setTimedOut(false);
      setProduceResult(null);
      request({ type: 'kafkaGetPartitions', topic: selectedTopic });
    }
  }, [selectedTopic, request]);

  const handleRefreshTopics = useCallback(() => {
    request({ type: 'kafkaListTopics' });
  }, [request]);

  // partition 数量不变时保留当前选中与消息, 只更新 offset
  const handleRefreshPartitions = useCallback(() => {
    if (selectedTopic) {
      request({ type: 'kafkaGetPartitions', topic: selectedTopic });
    }
  }, [selectedTopic, request]);

  const handleSelectTopic = useCallback((topic: string) => {
    setSelectedTopic(topic);
  }, []);

  // 换 partition 即放弃进行中的拉取 (其回执会被丢弃), 结束 loading 以免 Fetch 按钮一直禁用
  const handlePartitionChange = useCallback((partition: number) => {
    setSelectedPartition(partition);
    setMessages([]);
    setTimedOut(false);
    setLoading(false);
  }, []);

  const handleFetch = useCallback((offset: string) => {
    if (!selectedTopic) { return; }
    setLoading(true);
    setTimedOut(false);
    request({
      type: 'kafkaFetchMessages',
      topic: selectedTopic,
      partition: selectedPartition,
      offset,
      limit: 50,
    });
  }, [selectedTopic, selectedPartition, request]);

  // 宿主现取 high watermark 再拉最后 50 条, partition 下拉的 offset 随之刷新
  const handleFetchLatest = useCallback(() => {
    if (!selectedTopic) { return; }
    setLoading(true);
    setTimedOut(false);
    request({ type: 'kafkaFetchLatest', topic: selectedTopic, partition: selectedPartition, limit: 50 });
  }, [selectedTopic, selectedPartition, request]);

  const handleFetchByTimestamp = useCallback((timestamp: number) => {
    if (!selectedTopic) { return; }
    setLoading(true);
    setTimedOut(false);
    request({
      type: 'kafkaFetchByTimestamp',
      topic: selectedTopic,
      partition: selectedPartition,
      timestamp,
      limit: 50,
    });
  }, [selectedTopic, selectedPartition, request]);

  const handleProduce = useCallback((key: string | null, value: string, headers: Record<string, string>, partition?: number) => {
    if (!selectedTopic) { return; }
    setProduceResult(null);
    postMessage({
      type: 'kafkaProduceMessage',
      topic: selectedTopic,
      key,
      value,
      headers,
      partition,
    });
  }, [selectedTopic, postMessage]);

  // resize handle
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    startX.current = e.clientX;
    startWidth.current = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) { return; }
      const delta = ev.clientX - startX.current;
      setPanelWidth(Math.max(140, Math.min(600, startWidth.current + delta)));
    };

    const onMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  return (
    <div className="kafka-browser">
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="kafka-body">
        <div className="kafka-left-panel" style={{ width: panelWidth }}>
          <KafkaTopicList
            topics={topics}
            selectedTopic={selectedTopic}
            onSelectTopic={handleSelectTopic}
            onRefresh={handleRefreshTopics}
          />
        </div>
        <div className="kafka-resize-handle" onMouseDown={handleMouseDown} />
        <div className="kafka-right-panel">
          {selectedTopic ? (
            // 按 topic 重建: 切 topic 时 detail / produce 子视图与输入框回到初始状态
            <KafkaMessageTable
              key={selectedTopic}
              topic={selectedTopic}
              partitions={partitions}
              messages={messages}
              selectedPartition={selectedPartition}
              loading={loading}
              timedOut={timedOut}
              onPartitionChange={handlePartitionChange}
              onRefreshPartitions={handleRefreshPartitions}
              onFetch={handleFetch}
              onFetchLatest={handleFetchLatest}
              onFetchByTimestamp={handleFetchByTimestamp}
              onProduce={handleProduce}
              produceResult={produceResult}
            />
          ) : (
            <div className="kafka-empty">Select a topic to browse messages</div>
          )}
        </div>
      </div>
    </div>
  );
}
