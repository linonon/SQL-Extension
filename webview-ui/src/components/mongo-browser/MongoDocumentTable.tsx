import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ColumnInfo } from '../../../../src/types/query';
import { extractFieldPaths } from './mongo-autocomplete';
import { MongoFilterInput } from './MongoFilterInput';
import { ViewToggle, type MongoView } from './ViewToggle';
import { MongoDocumentList } from './MongoDocumentList';
import { MongoTableView } from './MongoTableView';
import { idToShell } from './mongo-id';
import { convertTags } from './mongo-field-editor';
import { MongoFilterHistory, type FilterHistoryEntry } from './MongoFilterHistory';
import { MongoExplainPanel } from './MongoExplainPanel';
import { capRows } from './mongo-render-cap';
import type { MongoExplainSummary, MongoQueryInputs } from '../../../../src/types/messages';
import { useReadOnly } from '../../hooks/useReadOnly';
import { AiAskBar } from '../query-editor/AiAskBar';

interface MongoDocumentTableProps {
  readonly database: string;
  readonly collection: string;
  readonly columns: readonly ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  // 已生效查询的总数; null 表示未知 (计数中 / 失败 / 超时)
  readonly total: number | null;
  readonly loading: boolean;
  readonly page: number;
  // 本页首行在查询结果里的偏移 (已生效的 Skip + 已翻过的页)
  readonly offset: number;
  readonly pageSize: number;
  readonly filter: string;
  readonly sort: string;
  readonly projection: string;
  // 已生效的 projection 不是顶层字段 0/1 取舍 (子路径 / 重命名 / 计算字段 / $slice), 写回会丢字段或写错值: 禁用 Edit / Clone / 单元格编辑
  readonly readOnly?: boolean;
  // 当前集合查询成功过的历史 (新的在前)
  readonly history: readonly FilterHistoryEntry[];
  readonly customLimit: string;
  readonly customSkip: string;
  readonly onFilterChange: (filter: string) => void;
  readonly onSortChange: (sort: string) => void;
  readonly onProjectionChange: (v: string) => void;
  readonly onLimitChange: (v: string) => void;
  readonly onSkipChange: (v: string) => void;
  readonly onApply: () => void;
  readonly onPageChange: (page: number) => void;
  // id / sourceId: 文档 _id 的 EJSON 值; original: 编辑器打开时的文档, doc: 编辑结果 (都是 EJSON)
  readonly onInsertDocument: (doc: Record<string, unknown>) => void;
  readonly onUpdateDocument: (id: unknown, original: Record<string, unknown>, doc: Record<string, unknown>) => void;
  readonly onCloneDocument: (sourceId: unknown, original: Record<string, unknown>, doc: Record<string, unknown>) => void;
  readonly onDeleteDocument: (id: unknown) => void;
  readonly queryError: string | null;
  // 最近一次文档写操作的回执 (每次一个新对象): 编辑器保存后等它, 成功才关编辑器, 失败保留草稿
  readonly writeResult?: { readonly ok: boolean } | null;
  readonly onExport?: () => void;
  readonly onImport?: () => void;
  readonly onExplain?: () => void;
  readonly explain?: { readonly loading?: boolean; readonly summary?: MongoExplainSummary; readonly error?: string } | null;
  readonly onCloseExplain?: () => void;
  readonly pendingSwitchSignal?: number;
  readonly onSwitchConfirmed?: () => void;
  readonly onSwitchCancelled?: () => void;
}

export function MongoDocumentTable({
  database,
  collection,
  columns,
  rows,
  total,
  loading,
  page,
  offset,
  pageSize,
  filter,
  sort,
  projection,
  readOnly = false,
  history,
  customLimit,
  customSkip,
  onFilterChange,
  onSortChange,
  onProjectionChange,
  onLimitChange,
  onSkipChange,
  onApply,
  onPageChange,
  onInsertDocument,
  onUpdateDocument,
  onCloneDocument,
  onDeleteDocument,
  queryError,
  writeResult,
  onExport,
  onImport,
  onExplain,
  explain,
  onCloseExplain,
  pendingSwitchSignal,
  onSwitchConfirmed,
  onSwitchCancelled,
}: MongoDocumentTableProps) {
  // 只读连接: 不给新建 / 导入 / 打开编辑入口 (卡片上的 Edit / Clone / Delete 由卡片自己禁用)
  const connectionReadOnly = useReadOnly();
  // in-card 编辑态: editing (正在编辑的现存文档) 与 composing (顶部新建/克隆卡片) 互斥
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const editingId = editing ? idToShell(editing._id) : null;
  const [composing, setComposing] = useState<Record<string, unknown> | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [view, setView] = useState<MongoView>('list');
  const [showSwitchDialog, setShowSwitchDialog] = useState(false);
  const [saveTrigger, setSaveTrigger] = useState(0);
  const [switchAfterSave, setSwitchAfterSave] = useState(false);
  const fieldNames = useMemo(() => extractFieldPaths(rows), [rows]);

  const editorActive = editingId !== null || composing !== null;
  const capped = capRows(rows);

  const endRow = offset + rows.length;
  // 总数未知时以 "本页取满" 判断还有下一页
  const hasNext = rows.length >= pageSize && (total === null || endRow < total);

  // 已发出保存, 等宿主回执 (writeResult) 再决定关编辑器还是保留草稿; 编辑器被关掉 (取消 / 放弃) 后回执与它无关
  const savePending = useRef(false);

  const clearEditor = useCallback(() => {
    savePending.current = false;
    setEditing(null);
    setComposing(null);
    setIsDirty(false);
  }, []);

  // 统一的"未保存改动"守卫: 当有脏编辑器时, 任何会替换/丢弃当前编辑的动作 (切 collection / Apply / 翻页 /
  // 编辑别的文档 / Clone / New / 切视图) 都先弹对话框, 由用户选择 Save / Discard / Cancel.
  const [pendingAction, setPendingAction] = useState<{ confirm: () => void; cancel: () => void } | null>(null);

  const guardedAction = useCallback((confirm: () => void, cancel: () => void = () => {}) => {
    if (editorActive && isDirty) {
      setPendingAction({ confirm, cancel });
      setShowSwitchDialog(true);
    } else {
      clearEditor();
      confirm();
    }
  }, [editorActive, isDirty, clearEditor]);

  const handleSave = useCallback((original: Record<string, unknown> | null, doc: Record<string, unknown>) => {
    // 回执到达前编辑器仍开着, 再点 Save 不重发 (Insert / Clone 重发会多插一条)
    if (savePending.current) { return; }
    if (editing) {
      onUpdateDocument(convertTags(editing._id), original ?? {}, doc);
    } else if (original) {
      // Clone: 源文档按编辑器打开时 seed 里的 _id 定位, 与编辑基准是同一份
      onCloneDocument(original._id, original, doc);
    } else {
      onInsertDocument(doc);
    }
    savePending.current = true;
  }, [editing, onUpdateDocument, onCloneDocument, onInsertDocument]);

  // 单元格编辑: 前后文档只含这一个 path, 与整文档编辑走同一条 diff 写回
  const handleCellEdit = useCallback((id: unknown, path: string, before: unknown, value: unknown) => {
    const nest = (v: unknown) =>
      path.split('.').reduceRight<unknown>((acc, k) => ({ [k]: acc }), v) as Record<string, unknown>;
    onUpdateDocument(convertTags(id), nest(convertTags(before)), nest(value));
  }, [onUpdateDocument]);

  const handleEnterEdit = useCallback((doc: Record<string, unknown>) => {
    guardedAction(() => setEditing(doc));
  }, [guardedAction]);

  // 表格视图里打开文档: 切回 List 并进入编辑
  const handleOpen = useCallback((doc: Record<string, unknown>) => {
    guardedAction(() => { setView('list'); setEditing(doc); });
  }, [guardedAction]);

  const handleNewDocument = useCallback(() => {
    // 新建卡片只在 List / JSON 视图渲染, Table 视图下先切到 List
    guardedAction(() => { setView((v) => (v === 'table' ? 'list' : v)); setComposing({}); });
  }, [guardedAction]);

  // Clone: 整文档 (含 _id) 作 seed 塞进顶部新建卡片, _id 可编辑; 保存时宿主按 _id 重读源文档套用改动后插入
  const handleClone = useCallback((doc: Record<string, unknown>) => {
    guardedAction(() => { setView((v) => (v === 'table' ? 'list' : v)); setComposing({ ...doc }); });
  }, [guardedAction]);

  // Table 视图不渲染编辑器, 切过去会丢掉编辑中的内容
  const handleViewChange = useCallback((v: MongoView) => {
    if (v !== view) { guardedAction(() => setView(v)); }
  }, [view, guardedAction]);

  // 编辑器保存失败 (非法 JSON / 缺 key / 宿主写入失败) 时, 取消挂起的 Save-then-action, 避免之后手动保存误触发它
  const handleSaveError = useCallback(() => {
    setSwitchAfterSave(false);
    setPendingAction(null);
  }, []);

  useEffect(() => {
    if (!writeResult || !savePending.current) { return; }
    savePending.current = false;
    if (writeResult.ok) { clearEditor(); } else { handleSaveError(); }
  }, [writeResult, clearEditor, handleSaveError]);

  // 切 collection 由父级 pendingSwitchSignal 触发, 走同一守卫
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pendingSwitchSignal) { return; }
    if (!editorActive || !isDirty) { clearEditor(); onSwitchConfirmed?.(); return; }
    setPendingAction({ confirm: () => onSwitchConfirmed?.(), cancel: () => onSwitchCancelled?.() });
    setShowSwitchDialog(true);
  }, [pendingSwitchSignal]);

  // 对话框点 Save: 等编辑器保存完 (editorActive 变 false) 再执行 pending 动作
  useEffect(() => {
    if (switchAfterSave && !editorActive) {
      setSwitchAfterSave(false);
      const a = pendingAction;
      setPendingAction(null);
      a?.confirm();
    }
  }, [editorActive, switchAfterSave, pendingAction]);

  const [showHistory, setShowHistory] = useState(false);
  const historyGroupRef = useRef<HTMLDivElement>(null);
  const [showAsk, setShowAsk] = useState(false);

  // Ask AI 的回答填进五个输入框: 不 Apply, 已生效的查询 (翻页 / Explain / Export 用的) 不变
  const handleFill = useCallback((q: MongoQueryInputs) => {
    onFilterChange(q.filter);
    onSortChange(q.sort);
    onProjectionChange(q.projection);
    onLimitChange(q.limit);
    onSkipChange(q.skip);
  }, [onFilterChange, onSortChange, onProjectionChange, onLimitChange, onSkipChange]);

  // 点击 History 下拉之外的区域关闭 (镜像 detail copy menu)
  useEffect(() => {
    if (!showHistory) { return; }
    const onDown = (e: MouseEvent) => {
      if (historyGroupRef.current && !historyGroupRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showHistory]);

  // Apply 经脏数据守卫; 查询进行中不重发: Apply 按钮与各输入框的 Enter 都走这里
  const applyQuery = useCallback(() => {
    if (loading) { return; }
    guardedAction(onApply);
  }, [loading, guardedAction, onApply]);

  const handlePageChange = useCallback((p: number) => {
    guardedAction(() => onPageChange(p));
  }, [guardedAction, onPageChange]);

  // 从历史恢复: 回填三个字段, 用户再点 Apply (避免与受控状态更新竞态)
  const handleRestoreQuery = useCallback((e: FilterHistoryEntry) => {
    onFilterChange(e.filter);
    onSortChange(e.sort);
    onProjectionChange(e.projection);
    setShowHistory(false);
  }, [onFilterChange, onSortChange, onProjectionChange]);

  const handleCopyQuery = useCallback(() => {
    const f = filter.trim() || '{}';
    const p = projection.trim();
    const s = sort.trim();
    const lim = parseInt(customLimit, 10);
    const sk = parseInt(customSkip, 10);

    // 不是合法 JS 标识符的集合名 (数字开头 / 中文 / 含 - 等) 要写成 getCollection("...")
    const coll = /^[A-Za-z_$][\w$]*$/.test(collection) ? `db.${collection}` : `db.getCollection(${JSON.stringify(collection)})`;
    let query = p
      ? `${coll}.find(${f}, ${p})`
      : `${coll}.find(${f})`;
    if (s) { query += `.sort(${s})`; }
    if (lim > 0) { query += `.limit(${lim})`; }
    if (sk > 0) { query += `.skip(${sk})`; }

    navigator.clipboard.writeText(query);
  }, [collection, filter, sort, projection, customLimit, customSkip]);

  return (
    <div className="mongo-document-panel">
      {showSwitchDialog && (
        <div className="mongo-nav-dialog-overlay">
          <div className="mongo-nav-dialog">
            <p className="mongo-nav-dialog-msg">当前文档有未保存的修改.</p>
            <div className="mongo-nav-dialog-actions">
              <button className="btn-small btn-primary" onClick={() => {
                setSwitchAfterSave(true);
                setSaveTrigger(t => t + 1);
                setShowSwitchDialog(false);
              }}>Save</button>
              <button className="btn-small" onClick={() => {
                clearEditor();
                setShowSwitchDialog(false);
                const a = pendingAction;
                setPendingAction(null);
                a?.confirm();
              }}>Discard</button>
              <button className="btn-small" onClick={() => {
                setShowSwitchDialog(false);
                const a = pendingAction;
                setPendingAction(null);
                a?.cancel();
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <div className="mongo-document-header">
        <div className="mongo-header-row">
          <h3>{database}.{collection}</h3>
          <ViewToggle value={view} onChange={handleViewChange} />
          {!connectionReadOnly && (
            <button
              className="btn-small btn-primary"
              onClick={handleNewDocument}
            >
              + New Document
            </button>
          )}
        </div>
        <div className="mongo-filter-controls">
          <div className="mongo-filter-row">
            <label className="mongo-filter-label">Filter:</label>
            <div className="mongo-filter-field">
              <MongoFilterInput
                value={filter}
                onChange={onFilterChange}
                onApply={applyQuery}
                fieldNames={fieldNames}
                placeholder='{uid: 123}'
              />
            </div>
          </div>
          <div className="mongo-filter-row">
            <label className="mongo-filter-label">Sort:</label>
            <div className="mongo-filter-field">
              <MongoFilterInput
                value={sort}
                onChange={onSortChange}
                onApply={applyQuery}
                fieldNames={fieldNames}
                placeholder='{_id: -1}'
              />
            </div>
          </div>
          <div className="mongo-filter-row">
            <label className="mongo-filter-label">Projection:</label>
            <div className="mongo-filter-field">
              <MongoFilterInput
                value={projection}
                onChange={onProjectionChange}
                onApply={applyQuery}
                fieldNames={fieldNames}
                placeholder='{name: 1, lv: 1}'
              />
            </div>
          </div>
          <div className="mongo-filter-row mongo-filter-row-bottom">
            <label className="mongo-filter-label">Limit:</label>
            <input
              type="text"
              className="mongo-numeric-input"
              value={customLimit}
              onChange={(e) => onLimitChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyQuery(); } }}
              placeholder="50"
            />
            <label className="mongo-filter-label-inline">Skip:</label>
            <input
              type="text"
              className="mongo-numeric-input"
              value={customSkip}
              onChange={(e) => onSkipChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyQuery(); } }}
              placeholder="0"
            />
            <button className="btn-small btn-primary" onClick={applyQuery} disabled={loading}>
              Apply
            </button>
            <div className="mongo-history-group" ref={historyGroupRef}>
              <button
                className="btn-small"
                onClick={() => setShowHistory((v) => !v)}
                title="Recent queries on this collection"
                aria-label="Query history"
              >
                History ▾
              </button>
              {showHistory && (
                <div className="mongo-filter-history-dropdown">
                  <MongoFilterHistory entries={history} onSelect={handleRestoreQuery} />
                </div>
              )}
            </div>
            <button className="btn-small" onClick={() => setShowAsk(true)} title="Ask AI to write the query for this collection">
              Ask AI
            </button>
            <div className="mongo-data-ops">
              {onExplain && (
                <button className="btn-small" onClick={onExplain} title="Explain: 查看索引使用 / 是否全表扫描">
                  Explain
                </button>
              )}
              <button className="btn-small" onClick={handleCopyQuery}>
                Copy
              </button>
              {onExport && (
                <button className="btn-small" onClick={onExport}>
                  Export
                </button>
              )}
              {onImport && !connectionReadOnly && (
                <button className="btn-small" onClick={onImport}>
                  Import
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {showAsk && (
        <AiAskBar
          key={`${database}/${collection}`}
          target="mongo"
          database={database}
          collection={collection}
          inputs={{ filter, sort, projection, limit: customLimit, skip: customSkip }}
          lastError={queryError ?? undefined}
          onFill={handleFill}
          onClose={() => setShowAsk(false)}
        />
      )}
      {explain && (
        <MongoExplainPanel
          summary={explain.summary}
          error={explain.error}
          loading={explain.loading}
          onClose={() => onCloseExplain?.()}
        />
      )}
      <div className="mongo-document-body">
        {loading && (
          <div className="mongo-spinner-wrap">
            <div className="mongo-spinner" />
            <span>Loading...</span>
          </div>
        )}
        {!loading && queryError && (
          <div className="mongo-error">Query failed: {queryError}</div>
        )}
        {!loading && !queryError && rows.length === 0 && composing === null && (
          <div className="mongo-empty">No documents found</div>
        )}
        {!loading && !queryError && capped.hidden > 0 && (
          <div className="mongo-render-cap-notice">
            性能保护: 仅渲染前 {capped.rows.length} / {rows.length} 条 (本页). 用 Filter 缩小范围或翻页 (每页 50).
          </div>
        )}
        {!loading && !queryError && readOnly && rows.length > 0 && (
          <div className="mongo-render-cap-notice">
            Projection 含子路径或表达式, 显示的不是完整的库内原值: Edit / Clone / 单元格编辑已禁用. 只有顶层字段取舍 (key 不含 '.', 值为 0 / 1) 的 Projection 可编辑.
          </div>
        )}
        {!loading && !queryError && (rows.length > 0 || composing !== null) && (
          view === 'table'
            ? <MongoTableView
                columns={columns}
                rows={capped.rows}
                onOpen={readOnly || connectionReadOnly ? undefined : handleOpen}
                onCellEdit={readOnly || connectionReadOnly ? undefined : handleCellEdit}
              />
            : <MongoDocumentList
                rows={capped.rows}
                view={view}
                readOnly={readOnly}
                fieldNames={fieldNames}
                editingId={editingId}
                composing={composing}
                onEdit={handleEnterEdit}
                onClone={handleClone}
                onDelete={(id) => onDeleteDocument(id)}
                onSave={handleSave}
                onCancelEdit={clearEditor}
                onDirtyChange={setIsDirty}
                onSaveError={handleSaveError}
                saveSignal={saveTrigger}
              />
        )}
      </div>
      {(rows.length > 0 || page > 0) && (
        <div className="mongo-pagination">
          <button
            className="btn-small"
            disabled={page === 0}
            onClick={() => handlePageChange(page - 1)}
          >
            Prev
          </button>
          <span className="page-info">
            {rows.length > 0 ? `${offset + 1}-${endRow}` : '0'} of {total ?? '?'}
          </span>
          <button
            className="btn-small"
            disabled={!hasNext}
            onClick={() => handlePageChange(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
