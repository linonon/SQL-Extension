import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useVSCodeMessage } from './hooks/useVSCodeMessage';
import { usePostMessage } from './hooks/usePostMessage';
import type { ConnectionFormProps } from './components/connection-form/ConnectionForm';
import type { ExtensionMessage, ViewType } from './types/messages';

// 各 view 按需加载
const DataGrid = lazy(() => import('./components/data-grid/DataGrid').then((m) => ({ default: m.DataGrid })));
const ConnectionForm = lazy(() => import('./components/connection-form/ConnectionForm').then((m) => ({ default: m.ConnectionForm })));
const QueryEditor = lazy(() => import('./components/query-editor/QueryEditor').then((m) => ({ default: m.QueryEditor })));
const EditTable = lazy(() => import('./components/edit-table/EditTable').then((m) => ({ default: m.EditTable })));
const RedisBrowser = lazy(() => import('./components/redis-browser/RedisBrowser').then((m) => ({ default: m.RedisBrowser })));
const KafkaBrowser = lazy(() => import('./components/kafka-browser/KafkaBrowser').then((m) => ({ default: m.KafkaBrowser })));
const RmqBrowser = lazy(() => import('./components/rmq-browser/RmqBrowser').then((m) => ({ default: m.RmqBrowser })));
const MongoBrowser = lazy(() => import('./components/mongo-browser/MongoBrowser').then((m) => ({ default: m.MongoBrowser })));
const MongoQueryEditor = lazy(() => import('./components/mongo-browser/MongoQueryEditor').then((m) => ({ default: m.MongoQueryEditor })));

export function App() {
  const [view, setView] = useState<ViewType | null>(null);
  const [viewContext, setViewContext] = useState<Record<string, unknown>>({});
  const postMessage = usePostMessage();

  const handleMessage = useCallback((message: ExtensionMessage) => {
    if (message.type === 'viewInit') {
      setView(message.view);
      setViewContext(message.context ?? {});
    }
  }, []);

  useVSCodeMessage(handleMessage);

  // listener 挂好后再发 ready, 保证不丢 viewInit
  useEffect(() => {
    postMessage({ type: 'ready' });
  }, [postMessage]);

  if (!view) {
    return <div style={{ padding: 16 }}>Loading...</div>;
  }

  const fallback = <div style={{ padding: 16 }}>Loading...</div>;

  switch (view) {
    case 'table':
      return (
        <Suspense fallback={fallback}>
          <DataGrid
            connectionId={viewContext.connectionId as string}
            database={viewContext.database as string}
            table={viewContext.table as string}
          />
        </Suspense>
      );
    case 'query':
      return (
        <Suspense fallback={fallback}>
          <QueryEditor
            connectionId={viewContext.connectionId as string}
            database={viewContext.database as string}
            driverType={viewContext.driverType as string | undefined}
            initialSql={viewContext.initialSql as string | undefined}
            autoExecute={viewContext.autoExecute as boolean | undefined}
            table={viewContext.table as string | undefined}
          />
        </Suspense>
      );
    case 'connection-form':
      return (
        <Suspense fallback={fallback}>
          <ConnectionForm editConnection={viewContext.editConnection as ConnectionFormProps['editConnection']} />
        </Suspense>
      );
    case 'edit-table':
      return (
        <Suspense fallback={fallback}>
          <EditTable
            database={viewContext.database as string}
            table={viewContext.table as string}
          />
        </Suspense>
      );
    case 'redis-browser':
      return (
        <Suspense fallback={fallback}>
          <RedisBrowser
            connectionId={viewContext.connectionId as string}
            database={viewContext.database as number}
          />
        </Suspense>
      );
    case 'kafka-browser':
      return (
        <Suspense fallback={fallback}>
          <KafkaBrowser
            connectionId={viewContext.connectionId as string}
            topic={viewContext.topic as string | undefined}
          />
        </Suspense>
      );
    case 'rmq-browser':
      return (
        <Suspense fallback={fallback}>
          <RmqBrowser
            connectionId={viewContext.connectionId as string}
          />
        </Suspense>
      );
    case 'mongo-browser':
      return (
        <Suspense fallback={fallback}>
          <MongoBrowser
            connectionId={viewContext.connectionId as string}
          />
        </Suspense>
      );
    case 'mongo-query':
      return (
        <Suspense fallback={fallback}>
          <MongoQueryEditor
            connectionId={viewContext.connectionId as string}
            database={viewContext.database as string}
            connectionName={viewContext.connectionName as string}
          />
        </Suspense>
      );
    default:
      return <div style={{ padding: 16 }}>Unknown view: {view}</div>;
  }
}
