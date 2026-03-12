import { useCallback, useEffect, useState } from 'react';
import { useVSCodeMessage } from './hooks/useVSCodeMessage';
import { usePostMessage } from './hooks/usePostMessage';
import { DataGrid } from './components/data-grid/DataGrid';
import { ConnectionForm, type ConnectionFormProps } from './components/connection-form/ConnectionForm';
import { QueryEditor } from './components/query-editor/QueryEditor';
import { EditTable } from './components/edit-table/EditTable';
import { RedisBrowser } from './components/redis-browser/RedisBrowser';
import { KafkaBrowser } from './components/kafka-browser/KafkaBrowser';
import { RmqBrowser } from './components/rmq-browser/RmqBrowser';
import { MongoBrowser } from './components/mongo-browser/MongoBrowser';
import { DatabaseBrowser } from './components/db-browser/DatabaseBrowser';
import { MongoQueryEditor } from './components/mongo-browser/MongoQueryEditor';
import type { ExtensionMessage, ViewType } from './types/messages';

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

  switch (view) {
    case 'table':
      return (
        <DataGrid
          connectionId={viewContext.connectionId as string}
          database={viewContext.database as string}
          table={viewContext.table as string}
        />
      );
    case 'query':
      return (
        <QueryEditor
          connectionId={viewContext.connectionId as string}
          database={viewContext.database as string}
          driverType={viewContext.driverType as string | undefined}
          initialSql={viewContext.initialSql as string | undefined}
          autoExecute={viewContext.autoExecute as boolean | undefined}
          table={viewContext.table as string | undefined}
        />
      );
    case 'connection-form':
      return <ConnectionForm editConnection={viewContext.editConnection as ConnectionFormProps['editConnection']} />;
    case 'edit-table':
      return (
        <EditTable
          database={viewContext.database as string}
          table={viewContext.table as string}
        />
      );
    case 'redis-browser':
      return (
        <RedisBrowser
          connectionId={viewContext.connectionId as string}
          database={viewContext.database as number}
          separator={(viewContext.separator as string) ?? ':'}
        />
      );
    case 'kafka-browser':
      return (
        <KafkaBrowser
          connectionId={viewContext.connectionId as string}
          topic={viewContext.topic as string | undefined}
        />
      );
    case 'rmq-browser':
      return (
        <RmqBrowser
          connectionId={viewContext.connectionId as string}
        />
      );
    case 'db-browser':
      return (
        <DatabaseBrowser
          connectionId={viewContext.connectionId as string}
          driverType={viewContext.driverType as string}
        />
      );
    case 'mongo-browser':
      return (
        <MongoBrowser
          connectionId={viewContext.connectionId as string}
        />
      );
    case 'mongo-query':
      return (
        <MongoQueryEditor
          connectionId={viewContext.connectionId as string}
          database={viewContext.database as string}
          connectionName={viewContext.connectionName as string}
        />
      );
    default:
      return <div style={{ padding: 16 }}>Unknown view: {view}</div>;
  }
}
