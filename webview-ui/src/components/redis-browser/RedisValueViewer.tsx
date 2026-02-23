import type { RedisKeyType, RedisValue } from '../../types/redis';
import { RedisStringEditor } from './RedisStringEditor';
import { RedisHashEditor } from './RedisHashEditor';
import { RedisListEditor } from './RedisListEditor';
import { RedisSetEditor } from './RedisSetEditor';
import { RedisSortedSetEditor } from './RedisSortedSetEditor';

interface RedisValueViewerProps {
  readonly keyName: string;
  readonly keyType: RedisKeyType;
  readonly ttl: number;
  readonly value: RedisValue | null;
  readonly commandOutput: string | null;
  readonly onSaveString: (value: string) => void;
  readonly onHashBatchEdit: (edits: ReadonlyArray<{ oldField: string; newField: string; value: string }>) => void;
  readonly onHashDeleteField: (field: string) => void;
  readonly hashDone: boolean;
  readonly onHashLoadMore: () => void;
  readonly onListPush: (value: string, position: 'head' | 'tail') => void;
  readonly onListRemove: (index: number) => void;
  readonly onListBatchSet: (entries: ReadonlyArray<{ readonly index: number; readonly value: string }>) => void;
  readonly onListLoadMore: () => void;
  readonly listHasMore: boolean;
  readonly onSetAdd: (member: string) => void;
  readonly onSetRemove: (member: string) => void;
  readonly onSetBatchEdit: (edits: ReadonlyArray<{ oldMember: string; newMember: string }>) => void;
  readonly onSetLoadMore: () => void;
  readonly setHasMore: boolean;
  readonly onZSetAdd: (member: string, score: number) => void;
  readonly onZSetRemove: (member: string) => void;
  readonly onZSetBatchEdit: (edits: ReadonlyArray<{ oldMember: string; newMember: string; score: number }>) => void;
  readonly onZSetLoadMore: () => void;
  readonly zsetHasMore: boolean;
  readonly onDeleteKey: () => void;
  readonly onSetTTL: () => void;
}

function formatTTL(ttl: number): string {
  if (ttl === -1) { return 'No expiry'; }
  if (ttl === -2) { return 'Expired'; }
  if (ttl < 60) { return `${ttl}s`; }
  if (ttl < 3600) { return `${Math.floor(ttl / 60)}m ${ttl % 60}s`; }
  return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`;
}

export function RedisValueViewer({
  keyName,
  keyType,
  ttl,
  value,
  commandOutput,
  onSaveString,
  onHashBatchEdit,
  onHashDeleteField,
  hashDone,
  onHashLoadMore,
  onListPush,
  onListRemove,
  onListBatchSet,
  onListLoadMore,
  listHasMore,
  onSetAdd,
  onSetRemove,
  onSetBatchEdit,
  onSetLoadMore,
  setHasMore,
  onZSetAdd,
  onZSetRemove,
  onZSetBatchEdit,
  onZSetLoadMore,
  zsetHasMore,
  onDeleteKey,
  onSetTTL,
}: RedisValueViewerProps) {
  // command raw output 优先显示
  if (commandOutput !== null) {
    return (
      <div className="redis-command-output">
        <div className="redis-value-header">
          <div className="key-info">
            <h3>Command Result</h3>
          </div>
        </div>
        <div className="redis-value-body">
          <pre>{commandOutput}</pre>
        </div>
      </div>
    );
  }

  if (!value) {
    return <div className="redis-empty">Select a key to view its value</div>;
  }

  return (
    <>
      <div className="redis-value-header">
        <div className="key-info">
          <h3>{keyName}</h3>
          <div className="key-meta">
            <span className={`type-badge ${keyType}`}>{keyType}</span>
            <span>TTL: {formatTTL(ttl)}</span>
          </div>
        </div>
        <button className="secondary" onClick={onSetTTL}>
          Set TTL
        </button>
        <button className="secondary" onClick={onDeleteKey}>
          Delete
        </button>
      </div>
      <div className="redis-value-body">
        {value.type === 'string' && (
          <RedisStringEditor value={value.value} onSave={onSaveString} />
        )}
        {value.type === 'hash' && (
          <RedisHashEditor
            value={value.value}
            onBatchEdit={onHashBatchEdit}
            onDeleteField={onHashDeleteField}
            hashDone={hashDone}
            onHashLoadMore={onHashLoadMore}
          />
        )}
        {value.type === 'list' && (
          <RedisListEditor
            value={value.value}
            total={value.total}
            onPush={onListPush}
            onRemove={onListRemove}
            onBatchSet={onListBatchSet}
            onLoadMore={onListLoadMore}
            hasMore={listHasMore}
          />
        )}
        {value.type === 'set' && (
          <RedisSetEditor
            members={value.value}
            hasMore={setHasMore}
            onAdd={onSetAdd}
            onRemove={onSetRemove}
            onBatchEdit={onSetBatchEdit}
            onLoadMore={onSetLoadMore}
          />
        )}
        {value.type === 'zset' && (
          <RedisSortedSetEditor
            entries={value.value}
            total={value.total}
            hasMore={zsetHasMore}
            onAdd={onZSetAdd}
            onRemove={onZSetRemove}
            onBatchEdit={onZSetBatchEdit}
            onLoadMore={onZSetLoadMore}
          />
        )}
      </div>
    </>
  );
}
