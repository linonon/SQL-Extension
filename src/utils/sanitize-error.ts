// 脱敏: 过滤错误消息里可能内嵌的凭证 (scheme://user:pass@host -> scheme://***@host),
// 避免连接错误把密码带到 webview / 日志. 单一来源, 供各 message handler 复用.
export function sanitizeErrorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message.replace(/([a-z][a-z0-9+\-.]*:\/\/)[^@\s]*@/gi, '$1***@')
    : String(err);
}
