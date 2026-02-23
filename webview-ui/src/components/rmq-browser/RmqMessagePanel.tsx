import { useCallback, useState } from 'react';
import type { RmqMessage } from '../../types/rabbitmq';
import { RmqMessageDetail } from './RmqMessageDetail';

interface RmqMessagePanelProps {
  readonly queue: string;
  readonly messages: readonly RmqMessage[];
  readonly loading: boolean;
  readonly onPeek: (count: number) => void;
}

type SubView = 'list' | 'detail';

// 截断过长的 payload 用于列表展示
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

export function RmqMessagePanel({ queue, messages, loading, onPeek }: RmqMessagePanelProps) {
  const [subView, setSubView] = useState<SubView>('list');
  const [detailMsg, setDetailMsg] = useState<RmqMessage | null>(null);
  const [peekCount, setPeekCount] = useState(10);

  const handlePeek = useCallback(() => {
    onPeek(peekCount);
  }, [onPeek, peekCount]);

  const handleRowClick = useCallback((msg: RmqMessage) => {
    setDetailMsg(msg);
    setSubView('detail');
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSubView('list');
    setDetailMsg(null);
  }, []);

  const handleCountChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setPeekCount(Number(e.target.value));
  }, []);

  // detail 视图
  if (subView === 'detail' && detailMsg) {
    return <RmqMessageDetail message={detailMsg} onClose={handleCloseDetail} />;
  }

  return (
    <div className="rmq-message-panel">
      <div className="rmq-message-header">
        <h3>{queue}</h3>
        <div className="rmq-peek-controls">
          <label>
            Count:
            <select value={peekCount} onChange={handleCountChange}>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          </label>
          <button className="btn-small" onClick={handlePeek} disabled={loading}>
            {loading ? 'Peeking...' : 'Peek Messages'}
          </button>
        </div>
        <div className="rmq-peek-warning">
          Peeking reads messages from the queue head and requeues them.
          This may reorder messages. Use with caution in production.
        </div>
      </div>
      <div className="rmq-message-body">
        {messages.length > 0 ? (
          <table className="rmq-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Exchange</th>
                <th>Routing Key</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((msg, idx) => (
                <tr
                  key={idx}
                  className="rmq-message-row"
                  onClick={() => handleRowClick(msg)}
                >
                  <td>{idx + 1}</td>
                  <td>{msg.exchange || '(default)'}</td>
                  <td>{msg.routingKey}</td>
                  <td>{truncate(msg.payload, 80)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="rmq-empty">
            Click "Peek Messages" to read messages from the queue
          </div>
        )}
      </div>
    </div>
  );
}
