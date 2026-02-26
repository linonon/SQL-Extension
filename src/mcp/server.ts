import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectionPool } from './connection-pool.js';
import { IpcClient } from './ipc-client.js';
import { registerConnectTools } from './tools/connect.js';
import { registerQueryTools } from './tools/query.js';

const pool = new ConnectionPool();
const ipc = new IpcClient();

const server = new McpServer({
  name: 'sql-extension',
  version: '0.1.0',
});

registerConnectTools(server, pool, ipc);
registerQueryTools(server, pool, ipc);

function cleanup(): void {
  pool.dispose();
  ipc.disconnect();
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

async function main(): Promise<void> {
  // 尝试连接 IPC (VS Code extension)
  try {
    await ipc.connect();
    process.stderr.write('sql-extension MCP server started (IPC mode: VS Code connected)\n');
  } catch {
    process.stderr.write('sql-extension MCP server started (standalone mode: VS Code not running)\n');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
