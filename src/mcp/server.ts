import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectionPool } from './connection-pool.js';
import { registerConnectTools } from './tools/connect.js';
import { registerQueryTools } from './tools/query.js';

const pool = new ConnectionPool();

const server = new McpServer({
  name: 'sql-extension',
  version: '0.1.0',
});

registerConnectTools(server, pool);
registerQueryTools(server, pool);

// 进程退出时清理连接
function cleanup(): void {
  pool.dispose();
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr 日志 (MCP 规范: stdout 为 JSON-RPC, stderr 可用于日志)
  process.stderr.write('sql-extension MCP server started\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
