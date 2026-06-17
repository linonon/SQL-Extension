import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ColumnInfo } from '../../types/database';
import { extractFieldPaths } from './mongo-autocomplete';
import { MongoFilterInput } from './MongoFilterInput';
import { ViewToggle, type MongoView } from './ViewToggle';
import { MongoDocumentList } from './MongoDocumentList';
import { MongoTableView } from './MongoTableView';
import { idToShell } from './mongo-id';
import { useMongoFilterHistory, MongoFilterHistory, type FilterHistoryEntry } from './MongoFilterHistory';
import { MongoFilterBuilder } from './MongoFilterBuilder';
import { MongoExplainPanel } from './MongoExplainPanel';
import type { MongoExplainSummary } from '../../types/messages';

interface MongoDocumentTableProps {
  readonly collection: string;
  readonly columns: readonly ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  readonly total: number;
  readonly loading: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly filter: string;
  readonly sort: string;
  readonly projection: string;
  readonly customLimit: string;
  readonly customSkip: string;
  readonly onFilterChange: (filter: string) => void;
  readonly onSortChange: (sort: string) => void;
  readonly onProjectionChange: (v: string) => void;
  readonly onLimitChange: (v: string) => void;
  readonly onSkipChange: (v: string) => void;
  readonly onApply: () => void;
  readonly onPageChange: (page: number) => void;
  readonly onInsertDocument: (doc: Record<string, unknown>) => void;
  readonly onUpdateDocument: (id: string, doc: Record<string, unknown>) => void;
  readonly onUpdateField?: (id: string, path: string, value: unknown) => void;
  readonly onDeleteDocument: (id: string) => void;
  readonly queryError: string | null;
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
  collection,
  columns,
  rows,
  total,
  loading,
  page,
  pageSize,
  filter,
  sort,
  projection,
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
  onUpdateField,
  onDeleteDocument,
  queryError,
  onExport,
  onImport,
  onExplain,
  explain,
  onCloseExplain,
  pendingSwitchSignal,
  onSwitchConfirmed,
  onSwitchCancelled,
}: MongoDocumentTableProps) {
  // in-card 编辑态: editingId (现存文档 _id 的 shell 形式) 与 composing (顶部新建/克隆卡片) 互斥
  const [editingId, setEditingId] = useState<string | null>(null);
  const [composing, setComposing] = useState<Record<string, unknown> | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [view, setView] = useState<MongoView>('list');
  const [showSwitchDialog, setShowSwitchDialog] = useState(false);
  const [saveTrigger, setSaveTrigger] = useState(0);
  const [switchAfterSave, setSwitchAfterSave] = useState(false);
  const fieldNames = useMemo(() => extractFieldPaths(rows), [rows]);

  const editorActive = editingId !== null || composing !== null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startRow = page * pageSize + 1;
  const endRow = Math.min((page + 1) * pageSize, total);

  const clearEditor = useCallback(() => {
    setEditingId(null);
    setComposing(null);
    setIsDirty(false);
  }, []);

  const handleSave = useCallback((id: string | null, doc: Record<string, unknown>) => {
    if (id) {
      onUpdateDocument(id, doc);
    } else {
      onInsertDocument(doc);
    }
    clearEditor();
  }, [onUpdateDocument, onInsertDocument, clearEditor]);

  const handleDelete = useCallback((id: string) => {
    onDeleteDocument(id);
    clearEditor();
  }, [onDeleteDocument, clearEditor]);

  const handleEnterEdit = useCallback((doc: Record<string, unknown>) => {
    setComposing(null);
    setEditingId(idToShell(doc._id));
  }, []);

  const handleNewDocument = useCallback(() => {
    setEditingId(null);
    setComposing({});
  }, []);

  // Clone: 整文档 (含 _id) 作 seed 塞进顶部新建卡片, _id 可编辑, 保存走 insert (天然保留 _id 类型)
  const handleClone = useCallback((doc: Record<string, unknown>) => {
    setEditingId(null);
    setComposing({ ...doc });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pendingSwitchSignal) { return; }
    if (!editorActive) { onSwitchConfirmed?.(); return; }
    if (!isDirty) { clearEditor(); onSwitchConfirmed?.(); return; }
    setShowSwitchDialog(true);
  }, [pendingSwitchSignal]);

  useEffect(() => {
    if (switchAfterSave && !editorActive) {
      setSwitchAfterSave(false);
      onSwitchConfirmed?.();
    }
  }, [editorActive, switchAfterSave, onSwitchConfirmed]);

  const { entries: filterHistory, addEntry: addFilterHistory } = useMongoFilterHistory();
  const [showHistory, setShowHistory] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  // 可视化构建器生成的 filter 回填到 Filter 框 (用户再点 Apply)
  const handleBuilderGenerate = useCallback((json: string) => {
    onFilterChange(json);
    setShowBuilder(false);
  }, [onFilterChange]);

  // Apply 时记录查询历史 (在真实 filter/sort/projection 上)
  const applyAndRecord = useCallback(() => {
    addFilterHistory(filter, sort, projection);
    onApply();
  }, [addFilterHistory, filter, sort, projection, onApply]);

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

    let query = p
      ? `db.${collection}.find(${f}, ${p})`
      : `db.${collection}.find(${f})`;
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
                onSwitchConfirmed?.();
              }}>Discard</button>
              <button className="btn-small" onClick={() => {
                setShowSwitchDialog(false);
                onSwitchCancelled?.();
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <div className="mongo-document-header">
        <div className="mongo-header-row">
          <h3>{collection}</h3>
          <ViewToggle value={view} onChange={setView} />
          <button
            className="btn-small btn-primary"
            onClick={handleNewDocument}
          >
            + New Document
          </button>
        </div>
        <div className="mongo-filter-controls">
          <div className="mongo-filter-row">
            <label className="mongo-filter-label">Filter:</label>
            <div className="mongo-filter-field">
              <MongoFilterInput
                value={filter}
                onChange={onFilterChange}
                onApply={applyAndRecord}
                fieldNames={fieldNames}
                placeholder='{ status: "active" }'
              />
            </div>
          </div>
          <div className="mongo-filter-row">
            <label className="mongo-filter-label">Sort:</label>
            <div className="mongo-filter-field">
              <MongoFilterInput
                value={sort}
                onChange={onSortChange}
                onApply={applyAndRecord}
                fieldNames={fieldNames}
                placeholder='{ _id: -1 }'
              />
            </div>
          </div>
          <div className="mongo-filter-row">
            <label className="mongo-filter-label">Projection:</label>
            <div className="mongo-filter-field">
              <MongoFilterInput
                value={projection}
                onChange={onProjectionChange}
                onApply={applyAndRecord}
                fieldNames={fieldNames}
                placeholder='{ name: 1, email: 1 }'
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
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyAndRecord(); } }}
              placeholder="50"
            />
            <label className="mongo-filter-label-inline">Skip:</label>
            <input
              type="text"
              className="mongo-numeric-input"
              value={customSkip}
              onChange={(e) => onSkipChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyAndRecord(); } }}
              placeholder="0"
            />
            <button className="btn-small btn-primary" onClick={applyAndRecord} disabled={loading}>
              Apply
            </button>
            <div className="mongo-history-group">
              <button
                className="btn-small"
                onClick={() => setShowBuilder((v) => !v)}
                title="可视化构建查询条件"
                aria-label="Filter builder"
              >
                Builder ▾
              </button>
              {showBuilder && (
                <div className="mongo-filter-builder-dropdown">
                  <MongoFilterBuilder
                    fieldNames={fieldNames}
                    onGenerate={handleBuilderGenerate}
                    onClose={() => setShowBuilder(false)}
                  />
                </div>
              )}
            </div>
            <div className="mongo-history-group">
              <button
                className="btn-small"
                onClick={() => setShowHistory((v) => !v)}
                title="Recent queries"
                aria-label="Query history"
              >
                History ▾
              </button>
              {showHistory && (
                <div className="mongo-filter-history-dropdown">
                  <MongoFilterHistory entries={filterHistory} onSelect={handleRestoreQuery} />
                </div>
              )}
            </div>
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
              {onImport && (
                <button className="btn-small" onClick={onImport}>
                  Import
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
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
        {!loading && !queryError && (rows.length > 0 || composing !== null) && (
          view === 'table'
            ? <MongoTableView columns={columns} rows={rows} onRowClick={(row) => { setView('list'); handleEnterEdit(row); }} onCellEdit={onUpdateField} />
            : <MongoDocumentList
                rows={rows}
                view={view}
                fieldNames={fieldNames}
                editingId={editingId}
                composing={composing}
                onEdit={handleEnterEdit}
                onClone={handleClone}
                onDelete={(id) => onDeleteDocument(id)}
                onSave={handleSave}
                onCancelEdit={clearEditor}
                onDirtyChange={setIsDirty}
                saveSignal={saveTrigger}
              />
        )}
      </div>
      {total > 0 && (
        <div className="mongo-pagination">
          <button
            className="btn-small"
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
          >
            Prev
          </button>
          <span className="page-info">
            {startRow}-{endRow} of {total}
          </span>
          <button
            className="btn-small"
            disabled={page >= totalPages - 1}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
