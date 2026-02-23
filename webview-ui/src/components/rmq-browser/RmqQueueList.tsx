import { useCallback, useState } from 'react';
import type { RmqQueueInfo } from '../../types/rabbitmq';

interface RmqQueueListProps {
  readonly queues: readonly RmqQueueInfo[];
  readonly selectedQueue: string | null;
  readonly onSelectQueue: (queue: string) => void;
}

// queue state 对应的 CSS class
function stateClass(state: string): string {
  if (state === 'running') { return 'running'; }
  if (state === 'idle') { return 'idle'; }
  return 'down';
}

export function RmqQueueList({ queues, selectedQueue, onSelectQueue }: RmqQueueListProps) {
  const [filter, setFilter] = useState('');

  const filtered = filter
    ? queues.filter((q) => q.name.toLowerCase().includes(filter.toLowerCase()))
    : queues;

  const handleFilterChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFilter(e.target.value);
  }, []);

  return (
    <div className="rmq-queue-list-panel">
      <div className="rmq-filter-bar">
        <input
          type="text"
          value={filter}
          onChange={handleFilterChange}
          placeholder="Filter queues..."
        />
      </div>
      <div className="rmq-queue-list">
        {filtered.map((q) => (
          <div
            key={q.name}
            className={`rmq-queue-item${selectedQueue === q.name ? ' selected' : ''}`}
            onClick={() => onSelectQueue(q.name)}
          >
            <span className={`rmq-state-dot ${stateClass(q.state)}`} />
            <span className="queue-name">{q.name}</span>
            <span className="queue-stats">{q.messages} msgs, {q.consumers} consumers</span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="rmq-empty">No queues found</div>
        )}
      </div>
    </div>
  );
}
