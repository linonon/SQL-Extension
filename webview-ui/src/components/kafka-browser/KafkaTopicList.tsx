import { useCallback, useState } from 'react';
import type { KafkaTopicInfo } from '../../types/kafka';

interface KafkaTopicListProps {
  readonly topics: readonly KafkaTopicInfo[];
  readonly selectedTopic: string | null;
  readonly onSelectTopic: (topic: string) => void;
}

export function KafkaTopicList({ topics, selectedTopic, onSelectTopic }: KafkaTopicListProps) {
  const [filter, setFilter] = useState('');

  const filtered = filter
    ? topics.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : topics;

  const handleFilterChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFilter(e.target.value);
  }, []);

  return (
    <div className="kafka-topic-list-panel">
      <div className="kafka-filter-bar">
        <input
          type="text"
          value={filter}
          onChange={handleFilterChange}
          placeholder="Filter topics..."
        />
      </div>
      <div className="kafka-topic-list">
        {filtered.map((t) => (
          <div
            key={t.name}
            className={`kafka-topic-item${selectedTopic === t.name ? ' selected' : ''}`}
            onClick={() => onSelectTopic(t.name)}
          >
            <span className="topic-name">{t.name}</span>
            <span className="topic-partitions">{t.partitionCount}p</span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="kafka-empty">No topics found</div>
        )}
      </div>
    </div>
  );
}
