import { useCallback, useEffect, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage, MongoExplainSummary } from '../../types/messages';
import type { ColumnInfo } from '../../types/database';
import { MongoCollectionList } from './MongoCollectionList';
import { MongoDocumentTable } from './MongoDocumentTable';
import '../../styles/mongo-browser.css';

interface MongoBrowserProps {
  readonly connectionId: string;
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

function resolveLimit(input: string, fallback: number): number {
  if (!input.trim()) { return fallback; }
  const n = parseInt(input, 10);
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}

function resolveSkip(input: string): number {
  if (!input.trim()) { return 0; }
  const n = parseInt(input, 10);
  return (Number.isFinite(n) && n >= 0) ? n : 0;
}

export function MongoBrowser({ connectionId }: MongoBrowserProps) {
  const [allCollections, setAllCollections] = useState<readonly GlobalCollectionInfo[]>([]);
  const [selected, setSelected] = useState<SelectedCollection | null>(null);
  const [columns, setColumns] = useState<readonly ColumnInfo[]>([]);
  const [rows, setRows] = useState<readonly Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('');
  const [projection, setProjection] = useState('');
  const [customLimit, setCustomLimit] = useState('');
  const [customSkip, setCustomSkip] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(220);
  const [pendingSwitchSignal, setPendingSwitchSignal] = useState(0);
  const [explain, setExplain] = useState<{ loading?: boolean; summary?: MongoExplainSummary; error?: string } | null>(null);
  const pendingSwitchTarget = useRef<{ database: string; name: string } | null>(null);

  const postMessage = usePostMessage();
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // 保存当前 filter/sort/projection/page 的 ref, 供 refetch 使用
  const filterRef = useRef(filter);
  const sortRef = useRef(sort);
  const projectionRef = useRef(projection);
  const customLimitRef = useRef(customLimit);
  const pageRef = useRef(page);
  filterRef.current = filter;
  sortRef.current = sort;
  projectionRef.current = projection;
  customLimitRef.current = customLimit;
  pageRef.current = page;

  const handleRefetch = useCallback(() => {
    if (!selected) { return; }
    const effectiveLimit = resolveLimit(customLimitRef.current, PAGE_SIZE);
    setQueryError(null);
    setLoading(true);
    postMessage({
      type: 'mongoFindDocuments',
      database: selected.database,
      collection: selected.name,
      filter: filterRef.current,
      sort: sortRef.current,
      projection: projectionRef.current,
      skip: pageRef.current * effectiveLimit,
      limit: effectiveLimit,
    });
  }, [selected, postMessage]);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    switch (msg.type) {
      case 'mongoAllCollectionList':
        setCollectionsLoading(false);
        setAllCollections(msg.collections);
        if (msg.collections.length > 0) {
          setSelected((prev) => prev ?? { database: msg.collections[0].database, name: msg.collections[0].name });
        }
        break;
      case 'mongoDocumentList':
        setColumns(msg.columns);
        setRows(msg.rows);
        setTotal(msg.total);
        setQueryError(msg.error ?? null);
        setLoading(false);
        break;
      case 'error':
        setLoading(false);
        // 集合列表加载若失败 (mongoListAllCollections 抛错), 后端回笼统 error: 同步清掉 spinner 避免左栏永久转
        setCollectionsLoading(false);
        setQueryError(msg.message);
        break;
      case 'mongoOperationResult':
        if (!msg.success) {
          alert(`Operation failed: ${msg.error ?? 'Unknown error'}`);
        } else {
          handleRefetch();
        }
        break;
      case 'mongoExportResult':
        if (!msg.success) {
          alert(`Export failed: ${msg.error ?? 'Unknown error'}`);
        }
        break;
      case 'mongoImportResult':
        if (!msg.success) {
          alert(`Import failed: ${msg.error ?? 'Unknown error'}`);
        } else {
          handleRefetch();
        }
        break;
      case 'mongoExplainResult':
        setExplain({ summary: msg.summary, error: msg.error });
        break;
      case 'mongoCollectionCreated':
        if (!msg.success) {
          alert(`Create collection failed: ${msg.error ?? 'Unknown error'}`);
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
          alert(`Drop collection failed: ${msg.error ?? 'Unknown error'}`);
        }
        break;
    }
  }, [handleRefetch]);

  useVSCodeMessage(handleMessage);

  // 初始加载所有 collections
  useEffect(() => {
    setCollectionsLoading(true);
    postMessage({ type: 'mongoListAllCollections' });
  }, [postMessage]);

  // 选中 collection 时自动加载首页文档
  useEffect(() => {
    if (selected) {
      setLoading(true);
      setPage(0);
      postMessage({
        type: 'mongoFindDocuments',
        database: selected.database,
        collection: selected.name,
        filter: '',
        sort: '',
        projection: '',
        skip: 0,
        limit: PAGE_SIZE,
      });
    }
  }, [selected, postMessage]);

  const handleSelectCollection = useCallback((database: string, name: string) => {
    pendingSwitchTarget.current = { database, name };
    setPendingSwitchSignal(s => s + 1);
  }, []);

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
    setPage(0);
  }, []);

  const onSwitchCancelled = useCallback(() => {
    pendingSwitchTarget.current = null;
  }, []);

  const handleApply = useCallback(() => {
    if (!selected) { return; }
    setQueryError(null);
    setLoading(true);
    setPage(0);
    const effectiveLimit = resolveLimit(customLimit, PAGE_SIZE);
    postMessage({
      type: 'mongoFindDocuments',
      database: selected.database,
      collection: selected.name,
      filter,
      sort,
      projection,
      skip: resolveSkip(customSkip),
      limit: effectiveLimit,
    });
  }, [selected, filter, sort, projection, customLimit, customSkip, postMessage]);

  const handlePageChange = useCallback((newPage: number) => {
    if (!selected) { return; }
    const effectiveLimit = resolveLimit(customLimit, PAGE_SIZE);
    setQueryError(null);
    setLoading(true);
    setPage(newPage);
    postMessage({
      type: 'mongoFindDocuments',
      database: selected.database,
      collection: selected.name,
      filter,
      sort,
      projection,
      skip: newPage * effectiveLimit,
      limit: effectiveLimit,
    });
  }, [selected, filter, sort, projection, customLimit, postMessage]);

  const handleInsertDocument = useCallback((doc: Record<string, unknown>) => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoInsertDocument',
      database: selected.database,
      collection: selected.name,
      document: doc,
    });
  }, [selected, postMessage]);

  const handleUpdateDocument = useCallback((id: string, doc: Record<string, unknown>) => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoUpdateDocument',
      database: selected.database,
      collection: selected.name,
      id,
      document: doc,
    });
  }, [selected, postMessage]);

  const handleDeleteDocument = useCallback((id: string) => {
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
      filter: filterRef.current,
      sort: sortRef.current,
    });
  }, [selected, postMessage]);

  const handleUpdateField = useCallback((id: string, path: string, value: unknown) => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoUpdateField',
      database: selected.database,
      collection: selected.name,
      id,
      path,
      value,
    });
  }, [selected, postMessage]);

  const handleExport = useCallback(() => {
    if (!selected) { return; }
    postMessage({
      type: 'mongoExportCollection',
      database: selected.database,
      collection: selected.name,
      filter: filterRef.current,
      sort: sortRef.current,
      projection: projectionRef.current,
    });
  }, [selected, postMessage]);

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
      <div className="mongo-body">
        <div className="mongo-left-panel" style={{ width: panelWidth }}>
          <MongoCollectionList
            collections={allCollections}
            selected={selected}
            loading={collectionsLoading}
            onSelectCollection={handleSelectCollection}
            onCreateCollection={handleCreateCollection}
            onDropCollection={handleDropCollection}
          />
        </div>
        <div className="mongo-resize-handle" onMouseDown={handleMouseDown} />
        <div className="mongo-right-panel">
          {selected ? (
            <MongoDocumentTable
              collection={selected.name}
              columns={columns}
              rows={rows}
              total={total}
              loading={loading}
              page={page}
              pageSize={resolveLimit(customLimit, PAGE_SIZE)}
              filter={filter}
              sort={sort}
              projection={projection}
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
              onUpdateField={handleUpdateField}
              onDeleteDocument={handleDeleteDocument}
              queryError={queryError}
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
