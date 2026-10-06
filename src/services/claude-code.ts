import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 借用本机已登录的 Claude Code 订阅: 以 `claude -p` 子进程跑单轮问答.
// --safe-mode 关掉 CLAUDE.md / hooks / 插件 / MCP 等个人定制 (登录照常), --tools "" 不给任何工具.

export const CLAUDE_CODE_PREFIX = 'claude-code:';
export const CLAUDE_CODE_MODELS = [
  { alias: 'sonnet', name: 'Claude Code · Sonnet' },
  { alias: 'opus', name: 'Claude Code · Opus' },
  { alias: 'haiku', name: 'Claude Code · Haiku' },
] as const;

const SYSTEM_PROMPT = 'You are a database query assistant embedded in a database client. Follow the instructions in the user message.';

// 从 Dock 启动的 VS Code 不带 shell 的 PATH, 补上常见安装位置
function findClaude(): string | null {
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of dirs) {
    const p = path.join(dir, 'claude');
    if (dir && fs.existsSync(p)) { return p; }
  }
  return null;
}

/** 本机有 claude 且已登录才返回其路径 */
export function claudeCodeAvailable(): Promise<string | null> {
  const bin = findClaude();
  if (!bin) { return Promise.resolve(null); }
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status'], { timeout: 10_000 }, (err, stdout) => {
      try {
        resolve(!err && JSON.parse(stdout).loggedIn === true ? bin : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export type StreamEvent = { text: string } | { model: string } | { error: string } | null;

/** 解析 `--output-format stream-json --include-partial-messages` 的一行 */
export function parseStreamLine(line: string): StreamEvent {
  let d: { type?: string; subtype?: string; model?: string; is_error?: boolean; result?: string; event?: { type?: string; delta?: { type?: string; text?: string } } };
  try { d = JSON.parse(line); } catch { return null; }
  if (d.type === 'system' && d.subtype === 'init' && d.model) { return { model: d.model }; }
  if (d.type === 'stream_event' && d.event?.type === 'content_block_delta' && d.event.delta?.type === 'text_delta') {
    return { text: d.event.delta.text ?? '' };
  }
  if (d.type === 'result' && d.is_error) { return { error: d.result || 'Claude Code request failed' }; }
  return null;
}

/** 流式回答 prompt; 返回实际所用模型 id. signal 中止时结束子进程. */
export function runClaudeCode(
  bin: string,
  alias: string,
  prompt: string,
  signal: AbortSignal,
  onChunk: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      '-p', '--safe-mode', '--tools', '', '--no-session-persistence',
      '--system-prompt', SYSTEM_PROMPT, '--model', alias,
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    ], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });

    let model = alias;
    let error = '';
    let stderr = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      buf += data;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const ev = parseStreamLine(line);
        if (!ev) { continue; }
        if ('text' in ev) { onChunk(ev.text); }
        else if ('model' in ev) { model = ev.model; }
        else { error = ev.error; }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('error', (err) => { signal.removeEventListener('abort', onAbort); reject(err); });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) { reject(new Error('Canceled')); return; }
      if (error || code !== 0) { reject(new Error(error || stderr.trim() || `claude exited with code ${code}`)); return; }
      resolve(model);
    });
    child.stdin.end(prompt);
  });
}
