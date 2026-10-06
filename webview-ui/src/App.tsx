import { useCallback, useEffect, useState } from 'react';
import { useVSCodeMessage } from './hooks/useVSCodeMessage';
import { usePostMessage } from './hooks/usePostMessage';
import { ConnectionForm, type ConnectionFormProps } from './components/connection-form/ConnectionForm';
import { QueryEditor } from './components/query-editor/QueryEditor';
import { EditTable } from './components/edit-table/EditTable';
import { RedisBrowser } from './components/redis-browser/RedisBrowser';
import { KafkaBrowser } from './components/kafka-browser/KafkaBrowser';
import { MongoBrowser } from './components/mongo-browser/MongoBrowser';
import { DatabaseBrowser } from './components/db-browser/DatabaseBrowser';
import { ReadOnlyContext } from './hooks/useReadOnly';
import type { ExtensionMessage, ViewType } from '../../src/types/messages';

export function App() {
  const [view, setView] = useState<ViewType | null>(null);
  const [viewContext, setViewContext] = useState<Record<string, unknown>>({});
  // 宿主的笼统失败回执 ({type:'error'}, 如按需重连失败) 在这里统一显示一次; 各视图只负责结束自己的 loading
  const [hostError, setHostError] = useState<string | null>(null);
  const postMessage = usePostMessage();

  const handleMessage = useCallback((message: ExtensionMessage) => {
    if (message.type === 'viewInit') {
      setView(message.view);
      setViewContext(message.context ?? {});
    }
    if (message.type === 'error') {
      setHostError(message.message);
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

  return (
    <ReadOnlyContext.Provider value={viewContext.readOnly === true}>
      {renderView(view, viewContext)}
      {hostError && (
        <div className="host-error-bar" role="alert">
          <span>{hostError}</span>
          <button onClick={() => setHostError(null)}>Dismiss</button>
        </div>
      )}
    </ReadOnlyContext.Provider>
  );
}

function renderView(view: ViewType, viewContext: Record<string, unknown>) {
  switch (view) {
    case 'query':
      return (
        <QueryEditor
          connectionId={viewContext.connectionId as string}
          connectionName={viewContext.connectionName as string | undefined}
          database={viewContext.database as string}
          driverType={viewContext.driverType as string | undefined}
          initialSql={viewContext.initialSql as string | undefined}
          autoExecute={viewContext.autoExecute as boolean | undefined}
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
        />
      );
    case 'db-browser':
      return (
        <DatabaseBrowser
          connectionId={viewContext.connectionId as string}
          driverType={viewContext.driverType as string}
          defaultDatabase={viewContext.defaultDatabase as string | undefined}
        />
      );
    case 'mongo-browser':
      return (
        <MongoBrowser
          connectionId={viewContext.connectionId as string}
        />
      );
    default:
      return <div style={{ padding: 16 }}>Unknown view: {view}</div>;
  }
}
