import type { RmqMessage } from '../../types/rabbitmq';

interface RmqMessageDetailProps {
  readonly message: RmqMessage;
  readonly onClose: () => void;
}

// 尝试 JSON 格式化 payload, 失败则返回原文
function formatPayload(payload: string, contentType: string | null): string {
  if (contentType === 'application/json' || !contentType) {
    try {
      return JSON.stringify(JSON.parse(payload), null, 2);
    } catch {
      return payload;
    }
  }
  return payload;
}

function formatDeliveryMode(mode: number | null): string {
  if (mode === 1) { return '1 (non-persistent)'; }
  if (mode === 2) { return '2 (persistent)'; }
  return mode !== null ? String(mode) : '-';
}

export function RmqMessageDetail({ message, onClose }: RmqMessageDetailProps) {
  const { properties } = message;
  const ts = properties.timestamp
    ? new Date(properties.timestamp * 1000).toLocaleString()
    : '-';
  const headerEntries = Object.entries(properties.headers);

  return (
    <div className="rmq-message-detail">
      <div className="detail-header">
        <h3>Message Detail</h3>
        <button className="btn-small" onClick={onClose}>Close</button>
      </div>
      <div className="detail-body">
        <div className="detail-row">
          <span className="detail-label">Exchange</span>
          <span className="detail-value">{message.exchange || '(default)'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Routing Key</span>
          <span className="detail-value">{message.routingKey}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Redelivered</span>
          <span className="detail-value">{message.redelivered ? 'Yes' : 'No'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Content Type</span>
          <span className="detail-value">{properties.contentType ?? '-'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Delivery Mode</span>
          <span className="detail-value">{formatDeliveryMode(properties.deliveryMode)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Message ID</span>
          <span className="detail-value">{properties.messageId ?? '-'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Timestamp</span>
          <span className="detail-value">{ts}</span>
        </div>
        {headerEntries.length > 0 && (
          <div className="detail-row">
            <span className="detail-label">Headers</span>
            <pre className="detail-pre">{JSON.stringify(properties.headers, null, 2)}</pre>
          </div>
        )}
        <div className="detail-row">
          <span className="detail-label">Payload</span>
          <pre className="detail-pre">
            {formatPayload(message.payload, properties.contentType)}
          </pre>
        </div>
      </div>
    </div>
  );
}
