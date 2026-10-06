import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IpcClient } from './ipc-client.js';
import { registerConnectTools } from './tools/connect.js';
import { registerReadTools } from './tools/query.js';
import { registerExecuteTools } from './tools/execute.js';
import { registerSchemaTools } from './tools/schema.js';

const ipc = new IpcClient();

// 本进程只把请求转给 VS Code 扩展 (IPC), 连接, 凭据与执行都在扩展里
const server = new McpServer(
  {
    name: 'sql-extension',
    version: '0.2.0',
  },
  {
    instructions: 'Databases are the connections the user saved in VS Code (Database Explorer); a VS Code window with the extension must be running. Call db_list_connections, then db_schema / db_read / db_execute with a connection id; connecting happens automatically. New connections are added by the user in VS Code.',
  },
);

registerConnectTools(server, ipc);
registerReadTools(server, ipc);
registerExecuteTools(server, ipc);
registerSchemaTools(server, ipc);

function cleanup(): void {
  ipc.disconnect();
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

async function main(): Promise<void> {
  // 启动时先探一次 VS Code; 连不上不退出, 每个请求会再按需重连
  try {
    await ipc.connect();
    process.stderr.write('sql-extension MCP server started (VS Code connected)\n');
  } catch {
    process.stderr.write('sql-extension MCP server started (VS Code not reachable yet; requests retry on demand)\n');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
