// MCP 进程 (ipc-client) 与扩展宿主 (ipc-server) 之间 NDJSON 协议的版本, 每个请求都带上.
// 两端分属两个 bundle, ~/.sql-extension 下可能留着旧扩展部署的 mcp-server.js: 请求或回包的字段 / 语义变了就加一,
// 宿主据此拒绝旧 MCP 进程, 不让它按旧格式理解新结果
export const PROTOCOL_VERSION = 1;

export const PROTOCOL_MISMATCH_ERROR = 'MCP server is from a different extension version; restart the MCP server (in Claude Code: /mcp) or reload VS Code';
