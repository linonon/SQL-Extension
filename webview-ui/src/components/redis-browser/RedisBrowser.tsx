import { useCallback, useEffect, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage } from '../../types/messages';
import type { RedisKeyInfo, RedisKeyType, RedisValue } from '../../types/redis';
import { RedisToolbar } from './RedisToolbar';
import { RedisKeyList } from './RedisKeyList';
import { RedisValueViewer } from './RedisValueViewer';
import '../../styles/redis-browser.css';

const PAGE_SIZE = 100;
const HASH_SCAN_COUNT = 100;

// redisScan 的请求序号: 回执 requestId 不是最近一次的 (换 pattern / 换库 / 刷新后旧 SCAN 晚到) 即丢弃, 不并进当前列表
let scanSeq = 0;

interface RedisBrowserProps {
  readonly connectionId: string;
  readonly database: number;
  readonly separator?: string;
}

// 根据 key type 生成对应的 command 提示; 集合类一律有界, 一键 Run 不会把大 key 整个拉进宿主
function buildCommandForKey(key: string, keyType: RedisKeyType): string {
  switch (keyType) {
    case 'hash': return `HSCAN ${key} 0 COUNT ${HASH_SCAN_COUNT}`;
    case 'string': return `GET ${key}`;
    case 'list': return `LRANGE ${key} 0 99`;
    case 'set': return `SSCAN ${key} 0 COUNT 100`;
    case 'zset': return `ZRANGE ${key} 0 99 WITHSCORES`;
    case 'stream': return `XRANGE ${key} - + COUNT 100`;
    default: return `TYPE ${key}`;
  }
}

export function RedisBrowser({ database: initialDb, separator = ':' }: RedisBrowserProps) {
  const postMessage = usePostMessage();
  const [panelWidth, setPanelWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) { return; }
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = Math.min(Math.max(e.clientX - rect.left, 200), rect.width - 200);
      setPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        setIsResizing(false);
      }
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const [db, setDb] = useState(initialDb);
  const [pattern, setPattern] = useState('*');
  const [keys, setKeys] = useState<readonly RedisKeyInfo[]>([]);
  const [filterQuery, setFilterQuery] = useState('');
  const [cursor, setCursor] = useState('0');
  const [hasMore, setHasMore] = useState(false);
  // 当前这次搜索累计扫过的 key 数 (估值) 与是否有 SCAN 请求在途
  const [scanned, setScanned] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedKeyType, setSelectedKeyType] = useState<RedisKeyType>('string');
  const [selectedTTL, setSelectedTTL] = useState(-1);
  const [value, setValue] = useState<RedisValue | null>(null);

  // databases 列表 (从 extension host 动态获取)
  const DEFAULT_DATABASES = Array.from({ length: 16 }, (_, i) => ({ index: i, keyCount: 0 }));
  const [databases, setDatabases] = useState<readonly { readonly index: number; readonly keyCount: number }[]>(DEFAULT_DATABASES);

  // command bar state
  const [commandText, setCommandText] = useState('*');
  const [commandOutput, setCommandOutput] = useState<string | null>(null);
  // 最近一次读写操作的失败原因 (webview sandbox 里 alert 不弹); 下一次成功或换 key / 搜索 / 换库时清掉
  const [opError, setOpError] = useState<string | null>(null);

  // hash 分页状态
  const [hashCursor, setHashCursor] = useState('0');
  const [hashDone, setHashDone] = useState(true);

  // set cursor 分页状态; list / zset 的下一页起点由已加载的 value (start + 长度) 推出, 不另存
  const [memberCursor, setMemberCursor] = useState('0');
  const [memberHasMore, setMemberHasMore] = useState(false);
  const setLoadingMore = useRef(false);
  const selectedKeyRef = useRef<string | null>(null);
  const scanIdRef = useRef(0);

  // 扫描 keys
  const doScan = useCallback((pat: string, cur: string, append: boolean) => {
    if (!append) {
      setKeys([]);
      setCursor('0');
      setHasMore(false);
      setScanned(0);
    }
    setScanning(true);
    scanIdRef.current = ++scanSeq;
    postMessage({ type: 'redisScan', requestId: scanIdRef.current, database: db, pattern: pat, cursor: cur, count: PAGE_SIZE });
  }, [db, postMessage]);

  // 初始加载数据库列表
  useEffect(() => {
    postMessage({ type: 'redisListDatabases' });
  }, [postMessage]);

  // 初始加载 + db 变化时扫描; 换 pattern 由 handleSearch 自己扫, 不经这里, 免得同一次搜索发两遍 SCAN
  useEffect(() => {
    doScan(pattern, '0', false);
  }, [db]); // eslint-disable-line react-hooks/exhaustive-deps

  // 处理消息
  const handleMessage = useCallback((message: ExtensionMessage) => {
    switch (message.type) {
      case 'redisScanResult': {
        if (message.requestId !== scanIdRef.current) { break; }
        setScanning(false);
        setScanned((prev) => prev + message.scanned);
        setHasMore(!message.done);
        setCursor(message.cursor);
        setKeys((prev) => {
          const existing = new Set(prev.map((k) => k.key));
          const newKeys = message.keys.filter((k) => !existing.has(k.key));
          return [...prev, ...newKeys];
        });
        break;
      }
      case 'redisValueResult': {
        // 只认当前选中 key 的回执: 晚到的旧 key 值显示在新 key 下, Save 会把它写进新 key
        if (message.key !== selectedKeyRef.current || message.database !== db) { break; }
        setCommandOutput(null);
        setSelectedKeyType(message.keyType);
        setSelectedTTL(message.ttl);
        // hash
        if (message.value.type === 'hash') {
          const hashVal = message.value;
          setHashCursor(hashVal.cursor);
          setHashDone(hashVal.cursor === '0');
          setValue(hashVal);
        }
        // set: load more 时追加, 否则替换
        else if (message.value.type === 'set') {
          const setVal = message.value;
          setMemberCursor(setVal.cursor);
          setMemberHasMore(setVal.cursor !== '0');
          if (setLoadingMore.current) {
            setLoadingMore.current = false;
            setValue((prev) => {
              if (prev?.type === 'set') {
                const existing = new Set(prev.value);
                const newMembers = setVal.value.filter((m: string) => !existing.has(m));
                return { type: 'set' as const, value: [...prev.value, ...newMembers], cursor: setVal.cursor };
              }
              return setVal;
            });
          } else {
            setValue(setVal);
          }
        }
        // list / zset: start 为 0 是首屏或写后重载, 替换; 否则是 Load More 的下一页, 必须紧接已加载的末尾才追加,
        // 对不上 (重载后晚到的旧页, 重复点击) 丢弃, 保证 value[i] 始终是 Redis index start + i
        else if (message.value.type === 'list') {
          const page = message.value;
          setValue((prev) => page.start === 0 ? page
            : prev?.type === 'list' && prev.start + prev.value.length === page.start
              ? { ...page, start: prev.start, value: [...prev.value, ...page.value] }
              : prev);
        }
        else if (message.value.type === 'zset') {
          const page = message.value;
          setValue((prev) => page.start === 0 ? page
            : prev?.type === 'zset' && prev.start + prev.value.length === page.start
              ? { ...page, start: prev.start, value: [...prev.value, ...page.value] }
              : prev);
        }
        // string / unsupported
        else {
          setMemberCursor('0');
          setMemberHasMore(false);
          setHashCursor('0');
          setHashDone(true);
          setValue(message.value);
        }
        break;
      }
      case 'redisHashScanResult': {
        if (message.key !== selectedKeyRef.current || message.database !== db) { break; }
        setHashCursor(message.cursor);
        setHashDone(message.done);
        setValue((prev) => {
          if (prev?.type === 'hash') {
            return {
              type: 'hash' as const,
              value: { ...prev.value, ...message.fields },
              cursor: message.cursor,
            };
          }
          return prev;
        });
        break;
      }
      case 'redisCommandResult': {
        setCommandOutput(message.output);
        break;
      }
      case 'redisOperationResult': {
        if (!message.success) {
          // SCAN 失败也走这里, 结束 Scanning 状态
          setScanning(false);
          setOpError(`Operation failed: ${message.error ?? 'Unknown error'}`);
          break;
        }
        setOpError(null);
        // 写成功后重拉第一页: 在途的 set Load More 不能把首屏追加到旧成员后面
        setLoadingMore.current = false;
        const key = selectedKeyRef.current;
        if (key) {
          postMessage({ type: 'redisGetValue', key, database: db });
        }
        break;
      }
      case 'error': {
        // 笼统失败 (如按需重连失败) 由 App 显示; 不清 scanning 则列表永远停在 Scanning...
        setScanning(false);
        break;
      }
      case 'redisDeleteKeysResult': {
        if (message.success) {
          const deleted = message.deletedKeys as string[];
          setKeys((prev) => prev.filter((k) => !deleted.includes(k.key)));
          if (selectedKeyRef.current && deleted.includes(selectedKeyRef.current)) {
            selectedKeyRef.current = null;
            setSelectedKey(null);
            setValue(null);
          }
        }
        break;
      }
      case 'redisDbList': {
        setDatabases(message.databases);
        break;
      }
      case 'redisImportResult': {
        if (message.success) {
          doScan(pattern, '0', false);
        }
        break;
      }
      case 'redisAddKeyResult': {
        const keyName = message.key;
        setKeys((prev) => {
          if (prev.some((k) => k.key === keyName)) { return prev; }
          return [...prev, { key: keyName, type: 'string' as const, ttl: -1 }];
        });
        break;
      }
      default:
        break;
    }
  }, [db, doScan, pattern, postMessage]);

  useVSCodeMessage(handleMessage);

  const handleSearch = useCallback((pat: string) => {
    setPattern(pat);
    setCommandText(pat);
    selectedKeyRef.current = null;
    setSelectedKey(null);
    setValue(null);
    setCommandOutput(null);
    setOpError(null);
    setFilterQuery('');
    doScan(pat, '0', false);
  }, [doScan]);

  const handleExecuteCommand = useCallback((command: string) => {
    setCommandOutput(null);
    postMessage({ type: 'redisExecuteCommand', command, database: db });
  }, [db, postMessage]);

  const handleDatabaseChange = useCallback((newDb: number) => {
    setDb(newDb);
    setPattern('*');
    setCommandText('*');
    selectedKeyRef.current = null;
    setSelectedKey(null);
    setValue(null);
    setCommandOutput(null);
    setOpError(null);
    setKeys([]);
  }, []);

  const handleRefresh = useCallback(() => {
    selectedKeyRef.current = null;
    setSelectedKey(null);
    setValue(null);
    setCommandOutput(null);
    setOpError(null);
    setFilterQuery('');
    doScan(pattern, '0', false);
  }, [pattern, doScan]);

  const handleLoadMore = useCallback(() => {
    doScan(pattern, cursor, true);
  }, [pattern, cursor, doScan]);

  const handleSelectKey = useCallback((key: string) => {
    selectedKeyRef.current = key;
    // 上一个 key 的 Load More 回执会被丢弃, 不能把追加标记留给新 key 的首屏
    setLoadingMore.current = false;
    setSelectedKey(key);
    // 回执到达前不显示上一个 key 的值: 此时 Save 针对的是新 key, 会把旧内容写进去
    setValue(null);
    setCommandOutput(null);
    setOpError(null);
    setMemberCursor('0');
    setMemberHasMore(false);
    setHashCursor('0');
    setHashDone(true);
    const keyInfo = keys.find((k) => k.key === key);
    if (keyInfo) {
      setSelectedKeyType(keyInfo.type);
      setSelectedTTL(keyInfo.ttl);
      setCommandText(buildCommandForKey(key, keyInfo.type));
    }
    postMessage({ type: 'redisGetValue', key, database: db });
  }, [keys, db, postMessage]);

  // extension host 已有 vscode.window.showWarningMessage 确认, 不需要 webview 再确认
  const handleDeleteKey = useCallback((key: string) => {
    postMessage({ type: 'redisDeleteKeys', keys: [key], database: db });
  }, [db, postMessage]);

  const handleSetTTLPrompt = useCallback((key?: string) => {
    const target = key ?? selectedKeyRef.current;
    if (!target) { return; }
    postMessage({ type: 'redisSetTTLPrompt', key: target, database: db });
  }, [db, postMessage]);

  // 导出当前库里匹配当前 pattern 的全部 key (extension host 跑完整轮 SCAN), 不只是已加载的
  const handleExportAll = useCallback(() => {
    postMessage({ type: 'redisExportPattern', database: db, pattern });
  }, [db, pattern, postMessage]);

  const handleExportKey = useCallback((key: string) => {
    postMessage({ type: 'redisExportKey', database: db, key });
  }, [db, postMessage]);

  const handleImport = useCallback(() => {
    postMessage({ type: 'redisImport', database: db });
  }, [db, postMessage]);

  const handleAddKey = useCallback(() => {
    postMessage({ type: 'redisAddKeyPrompt', database: db });
  }, [db, postMessage]);

  const handleSaveString = useCallback((val: string) => {
    if (!selectedKeyRef.current) { return; }
    postMessage({ type: 'redisSetString', key: selectedKeyRef.current, value: val, database: db });
  }, [db, postMessage]);

  const handleHashBatchEdit = useCallback((edits: ReadonlyArray<{ oldField: string; newField: string; value: string }>) => {
    if (!selectedKeyRef.current || edits.length === 0) { return; }
    postMessage({ type: 'redisHashBatchEdit', key: selectedKeyRef.current, edits, database: db });
  }, [db, postMessage]);

  const handleHashDeleteField = useCallback((field: string) => {
    if (!selectedKeyRef.current) { return; }
    postMessage({ type: 'redisHashDelete', key: selectedKeyRef.current, field, database: db });
  }, [db, postMessage]);

  const handleHashLoadMore = useCallback(() => {
    if (selectedKeyRef.current && hashCursor !== '0') {
      postMessage({ type: 'redisHashScan', key: selectedKeyRef.current, database: db, cursor: hashCursor, count: HASH_SCAN_COUNT });
    }
  }, [hashCursor, db, postMessage]);

  const handleListPush = useCallback((val: string, position: 'head' | 'tail') => {
    if (!selectedKeyRef.current) { return; }
    postMessage({ type: 'redisListPush', key: selectedKeyRef.current, value: val, position, database: db });
  }, [db, postMessage]);

  const handleListLoadMore = useCallback(() => {
    if (!selectedKeyRef.current || value?.type !== 'list') { return; }
    postMessage({ type: 'redisGetValue', key: selectedKeyRef.current, database: db, listStart: value.start + value.value.length });
  }, [value, db, postMessage]);

  const handleListRemove = useCallback((index: number) => {
    if (!selectedKeyRef.current) { return; }
    postMessage({ type: 'redisListRemove', key: selectedKeyRef.current, index, database: db });
  }, [db, postMessage]);

  const handleListBatchSet = useCallback((entries: ReadonlyArray<{ readonly index: number; readonly value: string }>) => {
    if (!selectedKeyRef.current || entries.length === 0) { return; }
    postMessage({ type: 'redisListBatchSet', key: selectedKeyRef.current, entries, database: db });
  }, [db, postMessage]);

  const handleSetAdd = useCallback((member: string) => {
    if (!selectedKeyRef.current) { return; }
    postMessage({ type: 'redisSetAdd', key: selectedKeyRef.current, member, database: db });
  }, [db, postMessage]);

  const handleSetRemove = useCallback((member: string) => {
    if (!selectedKeyRef.current) { return; }
    postMessage({ type: 'redisSetRemove', key: selectedKeyRef.current, member, database: db });
  }, [db, postMessage]);

  const handleSetBatchEdit = useCallback((edits: ReadonlyArray<{ oldMember: string; newMember: string }>) => {
    if (!selectedKeyRef.current || edits.length === 0) { return; }
    postMessage({ type: 'redisSetBatchEdit', key: selectedKeyRef.current, edits, database: db });
  }, [db, postMessage]);

  const handleSetLoadMore = useCallback(() => {
    if (selectedKeyRef.current && memberCursor !== '0') {
      setLoadingMore.current = true;
      postMessage({ type: 'redisGetValue', key: selectedKeyRef.current, database: db, setCursor: memberCursor });
    }
  }, [memberCursor, db, postMessage]);

  const handleZSetAdd = useCallback((member: string, score: number) => {
    if (!selectedKeyRef.current) { return; }
    postMessage({ type: 'redisZSetAdd', key: selectedKeyRef.current, member, score, database: db });
  }, [db, postMessage]);

  const handleZSetRemove = useCallback((member: string) => {
    if (!selectedKeyRef.current) { return; }
    postMessage({ type: 'redisZSetRemove', key: selectedKeyRef.current, member, database: db });
  }, [db, postMessage]);

  const handleZSetBatchEdit = useCallback((edits: ReadonlyArray<{ oldMember: string; newMember: string; score: number }>) => {
    if (!selectedKeyRef.current || edits.length === 0) { return; }
    postMessage({ type: 'redisZSetBatchEdit', key: selectedKeyRef.current, edits, database: db });
  }, [db, postMessage]);

  const handleZSetLoadMore = useCallback(() => {
    if (!selectedKeyRef.current || value?.type !== 'zset') { return; }
    postMessage({ type: 'redisGetValue', key: selectedKeyRef.current, database: db, zsetStart: value.start + value.value.length });
  }, [value, db, postMessage]);

  const listHasMore = value?.type === 'list' && value.start + value.value.length < value.total;
  const zsetHasMore = value?.type === 'zset' && value.start + value.value.length < value.total;

  return (
    <div className={`redis-browser${isResizing ? ' resizing' : ''}`}>
      <RedisToolbar
        database={db}
        databases={databases}
        commandText={commandText}
        onCommandTextChange={setCommandText}
        onExecuteCommand={handleExecuteCommand}
        onSearch={handleSearch}
        onDatabaseChange={handleDatabaseChange}
        onRefresh={handleRefresh}
        onAddKey={handleAddKey}
        onExport={handleExportAll}
        onImport={handleImport}
      />
      {opError && <div className="inline-error" role="alert">{opError}</div>}
      <div className="redis-body" ref={containerRef}>
        <div className="key-panel" style={{ width: panelWidth }}>
          {keys.length > 0 && (
            <div className="redis-filter-bar">
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filter loaded keys..."
              />
            </div>
          )}
          <RedisKeyList
            keys={keys}
            selectedKey={selectedKey}
            hasMore={hasMore}
            scanning={scanning}
            scanned={scanned}
            filterQuery={filterQuery}
            separator={separator}
            onSelectKey={handleSelectKey}
            onLoadMore={handleLoadMore}
            onDeleteKey={handleDeleteKey}
            onSetTTL={(key) => handleSetTTLPrompt(key)}
            onExportKey={handleExportKey}
          />
        </div>
        <div
          className="resize-handle"
          onMouseDown={() => { dragging.current = true; setIsResizing(true); }}
        />
        <div className="value-panel">
          <RedisValueViewer
            keyName={selectedKey ?? ''}
            keyType={selectedKeyType}
            ttl={selectedTTL}
            value={value}
            commandOutput={commandOutput}
            onSaveString={handleSaveString}
            onHashBatchEdit={handleHashBatchEdit}
            onHashDeleteField={handleHashDeleteField}
            hashDone={hashDone}
            onHashLoadMore={handleHashLoadMore}
            onListPush={handleListPush}
            onListRemove={handleListRemove}
            onListBatchSet={handleListBatchSet}
            onListLoadMore={handleListLoadMore}
            listHasMore={listHasMore}
            onSetAdd={handleSetAdd}
            onSetRemove={handleSetRemove}
            onSetBatchEdit={handleSetBatchEdit}
            onSetLoadMore={handleSetLoadMore}
            setHasMore={memberHasMore}
            onZSetAdd={handleZSetAdd}
            onZSetRemove={handleZSetRemove}
            onZSetBatchEdit={handleZSetBatchEdit}
            onZSetLoadMore={handleZSetLoadMore}
            zsetHasMore={zsetHasMore}
            onDeleteKey={() => selectedKey && handleDeleteKey(selectedKey)}
            onSetTTL={() => handleSetTTLPrompt()}
          />
        </div>
      </div>
    </div>
  );
}
