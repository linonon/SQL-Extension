import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '../ipc-client.js';
import { makeResult, makeError, toErrorMessage } from './mcp-result.js';

export function registerConnectTools(server: McpServer, ipc: IpcClient): void {
  server.registerTool(
    'db_list_connections',
    {
      title: 'List Database Connections',
      description: 'List the connections saved in VS Code (Database Explorer), in any state. Pass a connection id to db_schema / db_read / db_execute; they connect automatically. Connections listed with readOnly: true reject db_execute (code READONLY_VIOLATION); db_schema and db_read still work. New connections are added by the user in VS Code.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return makeResult({ connections: await ipc.request('listConnections') });
      } catch (err) {
        return makeError(toErrorMessage(err), 'IPC_FAILED');
      }
    }
  );
}
