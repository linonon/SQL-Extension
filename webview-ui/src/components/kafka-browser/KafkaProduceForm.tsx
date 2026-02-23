import { useState } from 'react';

interface KafkaProduceFormProps {
  readonly topic: string;
  readonly partitionCount: number;
  readonly produceResult: { readonly success: boolean; readonly partition?: number; readonly offset?: string; readonly error?: string } | null;
  readonly onProduce: (key: string | null, value: string, headers: Record<string, string>, partition?: number) => void;
  readonly onClose: () => void;
}

interface HeaderEntry {
  readonly key: string;
  readonly value: string;
}

export function KafkaProduceForm({
  topic,
  partitionCount,
  produceResult,
  onProduce,
  onClose,
}: KafkaProduceFormProps) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [headers, setHeaders] = useState<readonly HeaderEntry[]>([]);
  const [partition, setPartition] = useState<string>('auto');
  const [sending, setSending] = useState(false);

  const handleAddHeader = () => {
    setHeaders([...headers, { key: '', value: '' }]);
  };

  const handleRemoveHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
  };

  const handleHeaderChange = (index: number, field: 'key' | 'value', val: string) => {
    setHeaders(headers.map((h, i) => i === index ? { ...h, [field]: val } : h));
  };

  const handleSend = () => {
    if (!value.trim()) { return; }
    setSending(true);

    const headerMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.key.trim()) {
        headerMap[h.key.trim()] = h.value;
      }
    }

    const partNum = partition === 'auto' ? undefined : Number(partition);
    onProduce(key.trim() || null, value, headerMap, partNum);
  };

  // 收到结果后解除 sending 状态
  if (sending && produceResult) {
    setSending(false);
  }

  return (
    <div className="kafka-produce-form">
      <div className="detail-header">
        <h3>Produce to {topic}</h3>
        <button className="btn-small" onClick={onClose}>Close</button>
      </div>
      <div className="detail-body">
        <div className="detail-row">
          <label className="detail-label">Key (optional)</label>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="message key"
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        <div className="detail-row">
          <label className="detail-label">Value (required)</label>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder='{"event":"test"}'
            rows={6}
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 'var(--vscode-editor-font-size, 13px)' }}
          />
        </div>

        <div className="detail-row">
          <label className="detail-label">Partition</label>
          <select
            value={partition}
            onChange={(e) => setPartition(e.target.value)}
          >
            <option value="auto">Auto</option>
            {Array.from({ length: partitionCount }, (_, i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        </div>

        <div className="detail-row">
          <label className="detail-label">
            Headers
            <button className="btn-small" onClick={handleAddHeader} style={{ marginLeft: 8 }}>+ Add</button>
          </label>
          {headers.map((h, i) => (
            <div key={i} className="kafka-header-row">
              <input
                type="text"
                value={h.key}
                onChange={(e) => handleHeaderChange(i, 'key', e.target.value)}
                placeholder="key"
                className="kafka-header-input"
              />
              <input
                type="text"
                value={h.value}
                onChange={(e) => handleHeaderChange(i, 'value', e.target.value)}
                placeholder="value"
                className="kafka-header-input"
              />
              <button className="btn-small" onClick={() => handleRemoveHeader(i)}>x</button>
            </div>
          ))}
        </div>

        <div className="kafka-produce-actions">
          <button
            className="btn-small"
            onClick={handleSend}
            disabled={!value.trim() || sending}
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
          <button className="btn-small" onClick={onClose}>Cancel</button>
        </div>

        {produceResult && (
          <div className={`kafka-produce-result ${produceResult.success ? 'success' : 'error'}`}>
            {produceResult.success
              ? `Sent to partition ${produceResult.partition}, offset ${produceResult.offset}`
              : `Error: ${produceResult.error}`}
          </div>
        )}
      </div>
    </div>
  );
}
