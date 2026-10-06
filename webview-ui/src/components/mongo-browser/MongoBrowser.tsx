import { useCallback, useEffect, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage, MongoExplainSummary } from '../../../../src/types/messages';
import type { ColumnInfo } from '../../../../src/types/query';
import { parseShellJson } from '../../../../src/utils/mongo-shell-syntax';
import { MongoCollectionList } from './MongoCollectionList';
import { MongoDocumentTable } from './MongoDocumentTable';
import { useMongoFilterHistory, type FilterHistoryEntry } from './MongoFilterHistory';
import '../../styles/mongo-browser.css';

interface MongoBrowserProps {
  readonly connectionId: string;
  // 连接表单里填的 Database: 打开时选中它的第一个集合; 没填则不自动选中
  readonly defaultDatabase?: string;
}

export interface GlobalCollectionInfo {
  readonly database: string;
  readonly name: string;
  readonly count: number;
}

interface SelectedCollection {
  readonly database: string;
  readonly name: string;
}

const PAGE_SIZE = 50;
// Limit 上限: 一页的文档全部渲染, 更多的用 Next 翻; 导出不走 Limit
const MAX_LIMIT = 200;

// mongoFindDocuments 的请求序号: 回执 requestId 不是最近一次的 (切集合 / 翻页后旧查询晚到) 即丢弃,
// 否则旧集合的行会顶替当前集合, 随后的 Edit / Delete 按当前集合写进去
let findSeq = 0;

// 已生效的查询 (Apply / 切集合时快照): 翻页 / 刷新 / Explain / Export 都按它, 不读输入框里尚未 Apply 的文本
interface AppliedQuery {
  readonly filter: string;
  readonly sort: string;
  readonly projection: string;
  readonly skip: number;
  readonly limit: number;
}

const EMPTY_QUERY: AppliedQuery = { filter: '', sort: '', projection: '', skip: 0, limit: PAGE_SIZE };

function resolveLimit(input: string, fallback: number): number {
  if (!input.trim()) { return fallback; }
  const n = parseInt(input, 10);
  return (Number.isFinite(n) && n > 0) ? Math.min(n, MAX_LIMIT) : fallback;
}

function resolveSkip(input: string): number {
  if (!input.trim()) { return 0; }
  const n = parseInt(input, 10);
  return (Number.isFinite(n) && n >= 0) ? n : 0;
}

/**
 * projection 是否只按顶层字段整取整舍 (key 不含 '.', 值都是 0/1/true/false): 这时显示的字段都是库内的完整原值,
 * 按 path diff 写回只动改过的字段. 子路径 ("a.b" / 嵌套) 会把子文档数组的每个元素裁掉未投影的字段, 而数组整体 $set,
 * 写回会丢掉这些字段; 含表达式 ("$field" 重命名 / $slice / 计算字段) 时显示值不是库内值. 这两类都不可写回.
 */
export function isPathProjection(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) { return true; }
  let parsed: unknown;
  try { parsed = parseShellJson(trimmed); } catch { return false; }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && Object.entries(parsed).every(([k, v]) =>
      !k.startsWith('$') && !k.includes('.') && (typeof v === 'number' || typeof v === 'boolean'));
}

export function MongoBrowser({ connectionId, defaultDatabase }: MongoBrowserProps) {
  const [allCollections, setAllCollections] = useState<readonly GlobalCollectionInfo[]>([]);
  const [selected, setSelected] = useState<SelectedCollection | null>(null);
  const [columns, setColumns] = useState<readonly ColumnInfo[]>([]);
  const [rows, setRows] = useState<readonly Record<string, unknown>[]>([]);
  // null: 总数未知 (计数中 / 失败 / 超时)
  const [total, setTotal] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('');
  const [projection, setProjection] = useState('');
  const [customLimit, setCustomLimit] = useState('');
  const [customSkip, setCustomSkip] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  // 写操作 (文档 / 集合) 的失败原因, 行内显示 (webview sandbox 里 alert 不弹); 下次取数或写成功时清掉
  const [writeError, setWriteError] = useState<string | null>(null);
  // 每条文档写回执一个新对象, 编辑器据此决定关闭还是保留草稿
  const [writeResult, setWriteResult] = useState<{ readonly ok: boolean } | null>(null);
  const [panelWidth, setPanelWidth] = useState(220);
  const [pendingSwitchSignal, setPendingSwitchSignal] = useState(0);
  const [explain, setExplain] = useState<{ loading?: boolean; summary?: MongoExplainSummary; error?: string } | null>(null);
  const [applied, setApplied] = useState<AppliedQuery>(EMPTY_QUERY);
  const findIdRef = useRef(0);
  // 带 count 的那次查询的 requestId: 其后翻页不重算总数, 总数回执按它认领
  const countIdRef = useRef(0);
  const pendingSwitchTarget = useRef<{ database: string; name: string } | null>(null);
  // Apply 发出的查询: 它的回执无 error 才记进历史
  const pendingHistory = useRef<{ requestId: number; entry: Omit<FilterHistoryEntry, 'timestamp'> } | null>(null);
  const { entries: history, addEntry: addHistory } = useMongoFilterHistory();

  const postMessage = usePostMessage();
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // 唯一的取数入口: page 是相对 q.skip 的页号, skip / limit 都由已生效的查询推出; count 时重算总数
  const fetchDocs = useCallback((q: AppliedQuery, p: number, count: boolean) => {
    if (!selected) { return; }
    setQueryError(null);
    setWriteError(null);
    setLoading(true);
    setPage(p);
    findIdRef.current = ++findSeq;
    if (count) {
      countIdRef.current = findIdRef.current;
      setTotal(null);
    }
    postMessage({
      type: 'mongoFindDocuments',
      requestId: findIdRef.current,
      database: selected.database,
      collection: selected.name,
      filter: q.filter,
      sort: q.sort,
      projection: q.projection,
      skip: q.skip + p * q.limit,
      limit: q.limit,
      count,
    });
  }, [selected, postMessage]);

  // 写操作 / 导入后刷新: 留在当前页, 写入改变了文档数, 重算总数
  const handleRefetch = useCallback(() => fetchDocs(applied, page, true), [fetchDocs, applied, page]);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    switch (msg.type) {
      case 'mongoAllCollectionList':
        setCollectionsLoading(false);
        setAllCollections(msg.collections);
        setSelected((prev) => {
          if (prev) { return prev; }
          const first = msg.collections.find((c) => c.database === defaultDatabase);
          return first ? { database: first.database, name: first.name } : null;
        });
        break;
      case 'mongoDocumentList':
        if (msg.requestId !== findIdRef.current) { break; }
        if (!msg.error && pendingHistory.current?.requestId === msg.requestId) { addHistory(pendingHistory.current.entry); }
        setColumns(msg.columns);
        setRows(msg.rows);
        setQueryError(msg.error ?? null);
        setLoading(false);
        break;
      case 'mongoDocumentCount':
        if (msg.requestId === countIdRef.current) { setTotal(msg.total); }
        break;
      case 'error':
        // 笼统失败 (如按需重连失败) 由 App 显示; 这里清掉 spinner, 挂起的保存按失败处理 (保留草稿)
        setLoading(false);
        setCollectionsLoading(false);
        setWriteResult({ ok: false });
        setExplain((prev) => (prev?.loading ? null : prev));
        break;
      case 'mongoOperationResult':
        setWriteResult({ ok: msg.success });
        if (!msg.success) {
          setWriteError(`Operation failed: ${msg.error ?? 'Unknown error'}`);
        } else {
          handleRefetch();
        }
        break;
      // 导出 / 导入的失败由宿主弹提示 (宿主侧流程: 文件对话框 / 进度); 导入失败时前面的批次可能已落库, 照样刷新
      case 'mongoImportResult':
        handleRefetch();
        break;
      case 'mongoExplainResult':
        // 只接收进行中的 explain: 切 collection 时面板已清空, 旧 collection 迟到的结果丢弃
        setExplain((prev) => (prev?.loading ? { summary: msg.summary, error: msg.error } : prev));
        break;
      case 'mongoCollectionCreated':
        if (!msg.success) {
          setWriteError(`Create collection failed: ${msg.error ?? 'Unknown error'}`);
        }
        break;
      case 'mongoCollectionDropped':
        if (msg.success && msg.database && msg.collection) {
          setSelected((prev) => {
            if (prev?.database === msg.database && prev?.name === msg.collection) {
              return null;
            }
            return prev;
          });
        }
        if (!msg.success) {
          setWriteError(`Drop collection failed: ${msg.error ?? 'Unknown error'}`);
        }
        break;
    }
  }, [handleRefetch, defaultDatabase, addHistory]);

  useVSCodeMessage(handleMessage);

  const refreshCollections = useCallback(() => {
    setCollectionsLoading(true);
    postMessage({ type: 'mongoListAllCollections' });
  }, [postMessage]);

  // 初始加载所有 collections
  useEffect(() => { refreshCollections(); }, [refreshCollections]);

  // 选中 / 切换 collection: 查询复位, 关掉上一个集合的 explain, 清掉上一个集合的行 (加载中不显示在新集合名下), 从首页取并计数
  useEffect(() => {
    setApplied(EMPTY_QUERY);
    setExplain(null);
    setRows([]);
    fetchDocs(EMPTY_QUERY, 0, true);
  }, [selected, fetchDocs]);

  const onSwitchConfirmed = useCallback(() => {
    const target = pendingSwitchTarget.current;
    if (!target) { return; }
    pendingSwitchTarget.current = null;
    setSelected({ database: target.database, name: target.name });
    setFilter('');
    setSort('');
    setProjection('');
    setCustomLimit('');
    setCustomSkip('');
  }, []);

  // 有选中集合时由 MongoDocumentTable 守护未保存的编辑再切; 没有选中时表格未挂载, 直接切
  const handleSelectCollection = useCallback((database: string, name: string) => {
    pendingSwitchTarget.current = { database, name };
    if (!selected) { onSwitchConfirmed(); return; }
    setPendingSwitchSignal(s => s + 1);
  }, [selected, onSwitchConfirmed]);

  const onSwitchCancelled = useCallback(() => {
    pendingSwitchTarget.current = null;
  }, []);

  const handleApply = useCallback(() => {
    const q = { filter, sort, projection, skip: resolveSkip(customSkip), limit: resolveLimit(customLimit, PAGE_SIZE) };
    // 超过上限的 Limit 被钳住, 输入框回显实际生效的值
    if (customLimit.trim() && String(q.limit) !== customLimit.trim()) { setCustomLimit(String(q.limit)); }
    setApplied(q);
    // 旧的执行计划属于上一条查询
    setExplain(null);
    fetchDocs(q, 0, true);
    if (selected) {
      pendingHistory.current = { requestId: findIdRef.current, entry: { namespace: `${selected.database}.${selected.name}`, filter, sort, projection } };
    }
  }, [selected, filter, sort, projection, customSkip, customLimit, fetchDocs]);

  const handlePageChange = useCallback((p: number) => fetchDocs(applied, p, false), [fetchDocs, applied]);

  const handleInsertDocument = useCallback((doc: Record<string, unknown>) => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoInsertDocument',
      database: selected.database,
      collection: selected.name,
      document: doc,
    });
  }, [selected, postMessage]);

  const handleUpdateDocument = useCallback((id: unknown, original: Record<string, unknown>, doc: Record<string, unknown>) => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoUpdateDocument',
      database: selected.database,
      collection: selected.name,
      id,
      original,
      document: doc,
    });
  }, [selected, postMessage]);

  const handleCloneDocument = useCallback((sourceId: unknown, original: Record<string, unknown>, doc: Record<string, unknown>) => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoCloneDocument',
      database: selected.database,
      collection: selected.name,
      sourceId,
      original,
      document: doc,
    });
  }, [selected, postMessage]);

  const handleDeleteDocument = useCallback((id: unknown) => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoDeleteDocument',
      database: selected.database,
      collection: selected.name,
      id,
    });
  }, [selected, postMessage]);

  const handleExplain = useCallback(() => {
    if (!selected) { return; }
    setExplain({ loading: true });
    postMessage({
      type: 'mongoExplainQuery',
      database: selected.database,
      collection: selected.name,
      filter: applied.filter,
      sort: applied.sort,
    });
  }, [selected, applied, postMessage]);

  const handleExport = useCallback(() => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoExportCollection',
      database: selected.database,
      collection: selected.name,
      filter: applied.filter,
      sort: applied.sort,
      projection: applied.projection,
    });
  }, [selected, applied, postMessage]);

  const handleImport = useCallback(() => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoImportCollection',
      database: selected.database,
      collection: selected.name,
    });
  }, [selected, postMessage]);

  const handleCreateCollection = useCallback((database: string) => {
    postMessage({ type: 'mongoCreateCollection', database, collection: '' });
  }, [postMessage]);

  const handleDropCollection = useCallback((database: string, collection: string) => {
    postMessage({ type: 'mongoDropCollection', database, collection });
  }, [postMessage]);

  // resize handle
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    startX.current = e.clientX;
    startWidth.current = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) { return; }
      const delta = ev.clientX - startX.current;
      setPanelWidth(Math.max(140, Math.min(600, startWidth.current + delta)));
    };

    const onMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  return (
    <div className="mongo-browser">
      {writeError && <div className="mongo-error" role="alert">{writeError}</div>}
      <div className="mongo-body">
        <div className="mongo-left-panel" style={{ width: panelWidth }}>
          <MongoCollectionList
            collections={allCollections}
            selected={selected}
            loading={collectionsLoading}
            onRefresh={refreshCollections}
            onSelectCollection={handleSelectCollection}
            onCreateCollection={handleCreateCollection}
            onDropCollection={handleDropCollection}
          />
        </div>
        <div className="mongo-resize-handle" onMouseDown={handleMouseDown} />
        <div className="mongo-right-panel">
          {selected ? (
            <MongoDocumentTable
              database={selected.database}
              collection={selected.name}
              columns={columns}
              rows={rows}
              total={total}
              loading={loading}
              page={page}
              offset={applied.skip + page * applied.limit}
              pageSize={applied.limit}
              filter={filter}
              sort={sort}
              projection={projection}
              readOnly={!isPathProjection(applied.projection)}
              history={history.filter((e) => e.namespace === `${selected.database}.${selected.name}`)}
              customLimit={customLimit}
              customSkip={customSkip}
              onFilterChange={setFilter}
              onSortChange={setSort}
              onProjectionChange={setProjection}
              onLimitChange={setCustomLimit}
              onSkipChange={setCustomSkip}
              onApply={handleApply}
              onPageChange={handlePageChange}
              onInsertDocument={handleInsertDocument}
              onUpdateDocument={handleUpdateDocument}
              onCloneDocument={handleCloneDocument}
              onDeleteDocument={handleDeleteDocument}
              queryError={queryError}
              writeResult={writeResult}
              onExport={handleExport}
              onImport={handleImport}
              onExplain={handleExplain}
              explain={explain}
              onCloseExplain={() => setExplain(null)}
              pendingSwitchSignal={pendingSwitchSignal}
              onSwitchConfirmed={onSwitchConfirmed}
              onSwitchCancelled={onSwitchCancelled}
            />
          ) : (
            <div className="mongo-empty">Select a collection to browse documents</div>
          )}
        </div>
      </div>
    </div>
  );
}
