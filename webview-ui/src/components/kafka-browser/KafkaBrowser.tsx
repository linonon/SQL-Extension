import { useCallback, useEffect, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage } from '../../types/messages';
import type { KafkaTopicInfo, KafkaPartitionInfo, KafkaMessage } from '../../types/kafka';
import { KafkaTopicList } from './KafkaTopicList';
import { KafkaMessageTable } from './KafkaMessageTable';
import '../../styles/kafka-browser.css';

interface KafkaBrowserProps {
  readonly connectionId: string;
  readonly topic?: string;
}

export function KafkaBrowser({ connectionId, topic: initialTopic }: KafkaBrowserProps) {
  const [topics, setTopics] = useState<readonly KafkaTopicInfo[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(initialTopic ?? null);
  const [partitions, setPartitions] = useState<readonly KafkaPartitionInfo[]>([]);
  const [selectedPartition, setSelectedPartition] = useState(0);
  const [messages, setMessages] = useState<readonly KafkaMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelWidth, setPanelWidth] = useState(240);
  const [produceResult, setProduceResult] = useState<{ readonly success: boolean; readonly partition?: number; readonly offset?: string; readonly error?: string } | null>(null);

  const postMessage = usePostMessage();
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    switch (msg.type) {
      case 'kafkaTopicList':
        setTopics(msg.topics);
        break;
      case 'kafkaPartitionList':
        setPartitions((prev) => {
          // 如果是刷新 (partition 数量不变), 保留当前选中和消息列表
          if (prev.length > 0 && prev.length === msg.partitions.length) {
            return msg.partitions;
          }
          // 首次加载或 partition 变化, reset
          setSelectedPartition(msg.partitions.length > 0 ? msg.partitions[0].partitionId : 0);
          setMessages([]);
          setLoading(false);
          return msg.partitions;
        });
        break;
      case 'kafkaMessageList':
        setMessages(msg.messages);
        setLoading(false);
        break;
      case 'kafkaProduceResult':
        setProduceResult({ success: msg.success, partition: msg.partition, offset: msg.offset, error: msg.error });
        if (msg.success && selectedTopic) {
          postMessage({ type: 'kafkaGetPartitions', topic: selectedTopic });
        }
        break;
    }
  }, [selectedTopic, postMessage]);

  useVSCodeMessage(handleMessage);

  // 初始加载 topics
  useEffect(() => {
    postMessage({ type: 'kafkaListTopics' });
  }, [postMessage]);

  // 选中 topic 时加载 partitions
  useEffect(() => {
    if (selectedTopic) {
      setPartitions([]);
      setMessages([]);
      postMessage({ type: 'kafkaGetPartitions', topic: selectedTopic });
    }
  }, [selectedTopic, postMessage]);

  const handleSelectTopic = useCallback((topic: string) => {
    setSelectedTopic(topic);
  }, []);

  const handlePartitionChange = useCallback((partition: number) => {
    setSelectedPartition(partition);
    setMessages([]);
  }, []);

  const handleFetch = useCallback((offset: string) => {
    if (!selectedTopic) { return; }
    setLoading(true);
    postMessage({
      type: 'kafkaFetchMessages',
      topic: selectedTopic,
      partition: selectedPartition,
      offset,
      limit: 50,
    });
  }, [selectedTopic, selectedPartition, postMessage]);

  const handleFetchByTimestamp = useCallback((timestamp: number) => {
    if (!selectedTopic) { return; }
    setLoading(true);
    postMessage({
      type: 'kafkaFetchByTimestamp',
      topic: selectedTopic,
      partition: selectedPartition,
      timestamp,
      limit: 50,
    });
  }, [selectedTopic, selectedPartition, postMessage]);

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
      <div className="kafka-body">
        <div className="kafka-left-panel" style={{ width: panelWidth }}>
          <KafkaTopicList
            topics={topics}
            selectedTopic={selectedTopic}
            onSelectTopic={handleSelectTopic}
          />
        </div>
        <div className="kafka-resize-handle" onMouseDown={handleMouseDown} />
        <div className="kafka-right-panel">
          {selectedTopic ? (
            <KafkaMessageTable
              topic={selectedTopic}
              partitions={partitions}
              messages={messages}
              selectedPartition={selectedPartition}
              loading={loading}
              onPartitionChange={handlePartitionChange}
              onFetch={handleFetch}
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
