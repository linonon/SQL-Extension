import { useState, useEffect, useCallback } from 'react';
import vscodeApi from '../../vscode';
import type { ExtensionMessage } from '../../types/messages';
import type { ColumnInfo } from '../../types/database';
import { MongoAggregationBuilder } from './MongoAggregationBuilder';
import '../../styles/mongo-browser.css';

interface Props {
  readonly connectionId: string;
  readonly database: string;
  readonly connectionName: string;
}

interface QueryResult {
  readonly columns: readonly ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  readonly affectedRows: number;
  readonly executionTime: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export function MongoQueryEditor({ connectionId, database, connectionName }: Props) {
  const [queryText, setQueryText] = useState('db.collection.find({})');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [showAggBuilder, setShowAggBuilder] = useState(false);

  const handleExecute = useCallback(() => {
    if (!queryText.trim() || executing) { return; }
    setExecuting(true);
    setResult(null);
    vscodeApi.postMessage({ type: 'mongoRunQuery', database, query: queryText });
  }, [queryText, executing, database]);

  const handleCancel = useCallback(() => {
    vscodeApi.postMessage({ type: 'mongoCancelQuery' });
    setExecuting(false);
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionMessage;
      if (msg.type === 'mongoQueryResult') {
        setExecuting(false);
        setResult({
          columns: msg.columns,
          rows: msg.rows,
          affectedRows: msg.affectedRows,
          executionTime: msg.executionTime,
          truncated: msg.truncated,
          error: msg.error,
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleExecute();
    }
  };

  return (
    <div className="mongo-query-editor">
      <div className="mongo-query-header">
        <span className="mongo-query-conn">{connectionName}</span>
        <span className="mongo-query-db"> / {database}</span>
      </div>

      <textarea
        className="mongo-query-textarea"
        value={queryText}
        onChange={(e) => setQueryText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="db.collection.find({})"
        spellCheck={false}
      />

      <div className="mongo-query-actions">
        <button
          className="mongo-query-execute-btn"
          onClick={handleExecute}
          disabled={executing}
        >
          {executing ? 'Running...' : 'Execute'}
        </button>
        {executing && (
          <button className="mongo-query-cancel-btn" onClick={handleCancel}>
            Cancel
          </button>
        )}
        <button className="btn-small" onClick={() => setShowAggBuilder((v) => !v)}>
          Aggregation Builder {showAggBuilder ? '▴' : '▾'}
        </button>
        <span className="mongo-query-hint">Ctrl/Cmd+Enter to execute</span>
      </div>

      {showAggBuilder && (
        <MongoAggregationBuilder
          collection="collection"
          onGenerate={(q) => { setQueryText(q); setShowAggBuilder(false); }}
        />
      )}

      {result?.truncated && (
        <div className="mongo-query-truncated-warning">
          Showing first 500 rows. Results were truncated.
        </div>
      )}

      {result?.error && (
        <div className="mongo-query-error">{result.error}</div>
      )}

      {result && !result.error && result.affectedRows > 0 && result.rows.length === 0 && (
        <div className="mongo-query-affected">
          {result.affectedRows} documents affected ({result.executionTime}ms)
        </div>
      )}

      {result && !result.error && result.rows.length > 0 && (
        <div className="mongo-query-result-table-wrapper">
          <table className="mongo-query-result-table">
            <thead>
              <tr>
                {result.columns.map((col) => (
                  <th key={col.name}>{col.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map((col) => (
                    <td key={col.name}>
                      {row[col.name] == null
                        ? 'NULL'
                        : typeof row[col.name] === 'object'
                        ? JSON.stringify(row[col.name])
                        : String(row[col.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
