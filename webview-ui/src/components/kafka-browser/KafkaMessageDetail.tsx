import type { KafkaMessage } from '../../types/kafka';
import { formatJsonLossless } from '../../utils/json-format';

interface KafkaMessageDetailProps {
  readonly message: KafkaMessage;
  readonly onClose: () => void;
}

function formatValue(value: string | null): string {
  return value === null ? '(null)' : formatJsonLossless(value);
}

export function KafkaMessageDetail({ message, onClose }: KafkaMessageDetailProps) {
  const headerEntries = Object.entries(message.headers);
  const ts = message.timestamp
    ? new Date(Number(message.timestamp)).toLocaleString()
    : '-';

  return (
    <div className="kafka-message-detail">
      <div className="detail-header">
        <h3>Message Detail</h3>
        <button className="btn-small" onClick={onClose}>Close</button>
      </div>
      <div className="detail-body">
        <div className="detail-row">
          <span className="detail-label">Offset</span>
          <span className="detail-value">{message.offset}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Partition</span>
          <span className="detail-value">{message.partition}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Timestamp</span>
          <span className="detail-value">{ts}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Key</span>
          <pre className="detail-pre">{message.key ?? '(null)'}</pre>
        </div>
        <div className="detail-row">
          <span className="detail-label">Value</span>
          <pre className="detail-pre">{formatValue(message.value)}</pre>
        </div>
        {headerEntries.length > 0 && (
          <div className="detail-row">
            <span className="detail-label">Headers</span>
            <pre className="detail-pre">{JSON.stringify(message.headers, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
