import { useState } from 'react';
import type { KafkaMessage, KafkaPartitionInfo } from '../../types/kafka';
import { KafkaMessageDetail } from './KafkaMessageDetail';
import { KafkaProduceForm } from './KafkaProduceForm';

interface KafkaMessageTableProps {
  readonly topic: string;
  readonly partitions: readonly KafkaPartitionInfo[];
  readonly messages: readonly KafkaMessage[];
  readonly selectedPartition: number;
  readonly loading: boolean;
  readonly onPartitionChange: (partition: number) => void;
  readonly onFetch: (offset: string) => void;
  readonly onFetchByTimestamp: (timestamp: number) => void;
  readonly onProduce: (key: string | null, value: string, headers: Record<string, string>, partition?: number) => void;
  readonly produceResult: { readonly success: boolean; readonly partition?: number; readonly offset?: string; readonly error?: string } | null;
}

function truncate(s: string | null, max: number): string {
  if (s === null) { return '(null)'; }
  return s.length > max ? s.slice(0, max) + '...' : s;
}

type SubView = 'list' | 'detail' | 'produce';

export function KafkaMessageTable({
  topic,
  partitions,
  messages,
  selectedPartition,
  loading,
  onPartitionChange,
  onFetch,
  onFetchByTimestamp,
  onProduce,
  produceResult,
}: KafkaMessageTableProps) {
  const [subView, setSubView] = useState<SubView>('list');
  const [detailMsg, setDetailMsg] = useState<KafkaMessage | null>(null);
  const [offsetInput, setOffsetInput] = useState('');
  const [timestampInput, setTimestampInput] = useState('');

  const currentPartition = partitions.find((p) => p.partitionId === selectedPartition);
  const highWatermark = currentPartition?.offset ?? '0';

  const handleFetchLatest = () => {
    const start = Math.max(0, Number(highWatermark) - 50);
    onFetch(String(start));
  };

  const handleFetchOffset = () => {
    if (offsetInput.trim()) {
      onFetch(offsetInput.trim());
    }
  };

  const handleFetchByTimestamp = () => {
    if (!timestampInput) { return; }
    const ts = new Date(timestampInput).getTime();
    if (isNaN(ts)) { return; }
    onFetchByTimestamp(ts);
  };

  const handleShowDetail = (msg: KafkaMessage) => {
    setDetailMsg(msg);
    setSubView('detail');
  };

  if (subView === 'detail' && detailMsg) {
    return <KafkaMessageDetail message={detailMsg} onClose={() => setSubView('list')} />;
  }

  if (subView === 'produce') {
    return (
      <KafkaProduceForm
        topic={topic}
        partitionCount={partitions.length}
        produceResult={produceResult}
        onProduce={onProduce}
        onClose={() => setSubView('list')}
      />
    );
  }

  return (
    <div className="kafka-message-panel">
      <div className="kafka-message-header">
        <h3>{topic}</h3>
        <div className="kafka-controls">
          <label>
            Partition:
            <select
              value={selectedPartition}
              onChange={(e) => onPartitionChange(Number(e.target.value))}
            >
              {partitions.map((p) => (
                <option key={p.partitionId} value={p.partitionId}>
                  {p.partitionId} (offset: {p.offset})
                </option>
              ))}
            </select>
          </label>
          <div className="kafka-offset-controls">
            <input
              type="text"
              value={offsetInput}
              onChange={(e) => setOffsetInput(e.target.value)}
              placeholder="offset"
              className="offset-input"
            />
            <button className="btn-small" onClick={handleFetchOffset} disabled={loading}>
              Fetch
            </button>
            <button className="btn-small" onClick={handleFetchLatest} disabled={loading}>
              Latest
            </button>
          </div>
          <div className="kafka-offset-controls">
            <input
              type="datetime-local"
              value={timestampInput}
              onChange={(e) => setTimestampInput(e.target.value)}
              className="timestamp-input"
            />
            <button className="btn-small" onClick={handleFetchByTimestamp} disabled={loading || !timestampInput}>
              By Time
            </button>
          </div>
          <button className="btn-small" onClick={() => setSubView('produce')}>
            Produce
          </button>
        </div>
      </div>
      <div className="kafka-message-body">
        {loading && <div className="kafka-empty">Loading...</div>}
        {!loading && messages.length === 0 && (
          <div className="kafka-empty">No messages. Click "Latest" to fetch.</div>
        )}
        {!loading && messages.length > 0 && (
          <table className="kafka-table">
            <thead>
              <tr>
                <th>Offset</th>
                <th>Key</th>
                <th>Value</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr
                  key={`${m.partition}-${m.offset}`}
                  className="kafka-message-row"
                  onClick={() => handleShowDetail(m)}
                >
                  <td>{m.offset}</td>
                  <td>{truncate(m.key, 40)}</td>
                  <td>{truncate(m.value, 80)}</td>
                  <td title={m.timestamp ? new Date(Number(m.timestamp)).toISOString() : ''}>
                    {m.timestamp ?? '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
