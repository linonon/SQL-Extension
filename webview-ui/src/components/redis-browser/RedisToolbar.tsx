import { useCallback, useRef } from 'react';

interface RedisDbOption {
  readonly index: number;
  readonly keyCount: number;
}

interface RedisToolbarProps {
  readonly database: number;
  readonly databases: readonly RedisDbOption[];
  readonly commandText: string;
  readonly onCommandTextChange: (text: string) => void;
  readonly onExecuteCommand: (command: string) => void;
  readonly onSearch: (pattern: string) => void;
  readonly onDatabaseChange: (db: number) => void;
  readonly onRefresh: () => void;
  readonly onAddKey: () => void;
  readonly onExport: () => void;
  readonly onImport: () => void;
}

// 判断输入是否是 Redis command (而非 SCAN pattern)
function isRedisCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) { return false; }
  const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
  const commands = [
    'GET', 'SET', 'DEL', 'MGET', 'MSET', 'APPEND', 'INCR', 'DECR', 'INCRBY', 'DECRBY',
    'HGET', 'HSET', 'HDEL', 'HGETALL', 'HMGET', 'HMSET', 'HKEYS', 'HVALS', 'HLEN', 'HSCAN', 'HEXISTS',
    'LRANGE', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LLEN', 'LINDEX', 'LSET',
    'SADD', 'SREM', 'SMEMBERS', 'SISMEMBER', 'SCARD', 'SSCAN',
    'ZADD', 'ZREM', 'ZRANGE', 'ZRANGEBYSCORE', 'ZSCORE', 'ZCARD', 'ZCOUNT', 'ZSCAN',
    'KEYS', 'SCAN', 'TYPE', 'TTL', 'PTTL', 'EXPIRE', 'PERSIST', 'EXISTS', 'RENAME',
    'PING', 'INFO', 'DBSIZE', 'FLUSHDB', 'SELECT', 'CONFIG', 'CLIENT',
    'XADD', 'XLEN', 'XRANGE', 'XREAD',
  ];
  return commands.includes(firstWord);
}

export function RedisToolbar({
  database,
  databases,
  commandText,
  onCommandTextChange,
  onExecuteCommand,
  onSearch,
  onDatabaseChange,
  onRefresh,
  onAddKey,
  onExport,
  onImport,
}: RedisToolbarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleExecute = useCallback(() => {
    const text = commandText.trim();
    if (isRedisCommand(text)) {
      onExecuteCommand(text);
    } else {
      onSearch(text || '*');
    }
  }, [commandText, onExecuteCommand, onSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleExecute();
      }
    },
    [handleExecute]
  );

  return (
    <div className="redis-toolbar">
      <div className="redis-command-bar">
        <textarea
          ref={textareaRef}
          value={commandText}
          onChange={(e) => onCommandTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Redis command (e.g. GET key) or SCAN pattern (e.g. user:*) - Ctrl+Enter to run"
          rows={1}
          spellCheck={false}
        />
        <button className="run-btn" title="Run (Ctrl+Enter)" onClick={handleExecute}>
          Run
        </button>
      </div>
      <div className="redis-toolbar-actions">
        <select
          value={database}
          onChange={(e) => onDatabaseChange(Number(e.target.value))}
        >
          {databases.map((d) => (
            <option key={d.index} value={d.index}>{`db${d.index} (${d.keyCount})`}</option>
          ))}
        </select>
        <button className="icon-btn" title="Refresh" onClick={onRefresh}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.527 1.225.527 1.924a4.008 4.008 0 0 1-4.006 4.006 4.007 4.007 0 0 1-3.742-2.555l1.244-.009-.067-1.5-3.456.024.025 3.456 1.5-.01-.01-1.252A5.508 5.508 0 0 0 8.249 13.006 5.509 5.509 0 0 0 13.755 7.5c0-0.675-.122-1.32-.304-1.891zM8.249 2.494a5.508 5.508 0 0 0-5.175 3.61l.579.939 1.068-.812.076-.094A3.98 3.98 0 0 1 5.27 4.913 4.007 4.007 0 0 1 8.249 2.994a4.008 4.008 0 0 1 3.742 2.555l-1.244.009.067 1.5 3.456-.024-.025-3.456-1.5.01.01 1.252A5.508 5.508 0 0 0 8.249 2.494z"/>
          </svg>
        </button>
        <button className="icon-btn" title="Add Key" onClick={onAddKey}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5a.5.5 0 0 1 .5.5v5.5H14a.5.5 0 0 1 0 1H8.5V14a.5.5 0 0 1-1 0V8.5H2a.5.5 0 0 1 0-1h5.5V2a.5.5 0 0 1 .5-.5z"/>
          </svg>
        </button>
        <button className="text-btn" title="Export Keys" onClick={onExport}>Export</button>
        <button className="text-btn" title="Import Keys" onClick={onImport}>Import</button>
      </div>
    </div>
  );
}
