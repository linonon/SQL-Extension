import * as vscode from 'vscode';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PREFIX, claudeCodeAvailable, runClaudeCode } from './claude-code.js';

// schema 序列化上限: 大库表多时截断, 防 prompt 超出模型上下文
const SCHEMA_CHAR_LIMIT = 30_000;

export interface AiAskInput {
  readonly dialect: string;
  readonly database: string;
  readonly schema: Record<string, string[]>;
  readonly question: string;
  readonly sql: string;
  readonly selection: string;
}

// 问题 / SQL 里提到的表排前面, 再按整行截断: 大库截断时被问的表不会恰好被切掉
function schemaLines(input: AiAskInput): string {
  const words = new Set(`${input.question}\n${input.sql}\n${input.selection}`.toLowerCase().match(/[a-z0-9_$]+/g));
  const mentioned = (t: string) => words.has(t.toLowerCase());
  const entries = Object.entries(input.schema);
  const ordered = [...entries.filter(([t]) => mentioned(t)), ...entries.filter(([t]) => !mentioned(t))];
  const lines: string[] = [];
  let size = 0;
  for (const [table, cols] of ordered) {
    const line = `${table}(${cols.join(', ')})`;
    if (size + line.length > SCHEMA_CHAR_LIMIT) {
      lines.push(`... (${ordered.length - lines.length} more tables truncated)`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

export function buildAiPrompt(input: AiAskInput): string {
  const schemaText = schemaLines(input);
  return [
    `You are a ${input.dialect} assistant embedded in a SQL editor. Current database: ${input.database}.`,
    'Answer concisely in the language of the question.',
    'When the answer involves SQL, put exactly one complete runnable statement set in a single ```sql code block;',
    'it replaces the selected SQL if any, otherwise the whole editor content, so keep unrelated statements the user has.',
    'Only use tables/columns from the schema below (if it is truncated, other tables may exist).',
    '',
    'Schema (table(columns)):',
    schemaText || '(empty)',
    '',
    'Editor content:',
    input.sql || '(empty)',
    ...(input.selection ? ['', 'Selected SQL:', input.selection] : []),
    '',
    'Question:',
    input.question,
  ].join('\n');
}

const MODEL_SETTING = 'ai.model';

function configuredModelId(): string {
  return vscode.workspace.getConfiguration('sqlext').get<string>(MODEL_SETTING, '');
}

/** 可用模型: 本机已登录的 Claude Code 在前 (默认优先), Copilot 兜底; selected 为设置值 (为空即用第一个) */
export async function listAiModels(): Promise<{ models: { id: string; name: string }[]; selected: string }> {
  const [copilot, claudeBin] = await Promise.all([
    vscode.lm.selectChatModels({ vendor: 'copilot' }).then(ms => ms, () => []),
    claudeCodeAvailable(),
  ]);
  const models = [
    ...(claudeBin ? CLAUDE_CODE_MODELS.map(m => ({ id: CLAUDE_CODE_PREFIX + m.alias, name: m.name })) : []),
    ...copilot.map(m => ({ id: m.id, name: m.name })),
  ];
  return { models, selected: configuredModelId() };
}

export async function setAiModel(id: string): Promise<void> {
  await vscode.workspace.getConfiguration('sqlext').update(MODEL_SETTING, id, vscode.ConfigurationTarget.Global);
}

// 每个 panel 同时只有一个进行中的提问, 新提问 / aiCancel 会取消旧的
const pending = new WeakMap<object, vscode.CancellationTokenSource>();

export function cancelAiAsk(key: object): void {
  pending.get(key)?.cancel();
  pending.delete(key);
}

/**
 * 按设置 sqlext.ai.model 选模型回答 (Copilot 模型或本机 Claude Code), 流式回调 onChunk; 返回所用模型名.
 * getInput 在登记取消之后才执行: 取 schema 期间的 Stop / Close 也能拦住请求.
 */
export async function runAiAsk(
  key: object,
  getInput: () => Promise<AiAskInput>,
  onChunk: (text: string) => void,
): Promise<string> {
  cancelAiAsk(key);
  const cts = new vscode.CancellationTokenSource();
  pending.set(key, cts);
  try {
    const input = await getInput();
    if (cts.token.isCancellationRequested) { throw new vscode.CancellationError(); }
    const prompt = buildAiPrompt(input);
    // 未设置时优先本机 Claude Code (与下拉框首项一致), 未登录才回落 Copilot
    const setting = configuredModelId();
    const bin = !setting || setting.startsWith(CLAUDE_CODE_PREFIX) ? await claudeCodeAvailable() : null;
    const chosen = setting || (bin ? CLAUDE_CODE_PREFIX + CLAUDE_CODE_MODELS[0].alias : '');
    let used: string;
    if (chosen.startsWith(CLAUDE_CODE_PREFIX)) {
      if (!bin) {
        throw new Error('Claude Code is not installed or not logged in (run `claude auth login`), or pick another model.');
      }
      const ac = new AbortController();
      cts.token.onCancellationRequested(() => ac.abort());
      used = await runClaudeCode(bin, chosen.slice(CLAUDE_CODE_PREFIX.length), prompt, ac.signal, onChunk);
    } else {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      // 设置里的模型已不可用 (换了订阅 / 下线) 时回落到第一个, 实际所用模型名随 aiDone 回传
      const model = models.find(m => m.id === chosen) ?? models[0];
      if (!model) {
        throw new Error('No Copilot language model available. Install/sign in to GitHub Copilot, or log in to Claude Code.');
      }
      const res = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        { justification: 'Database Explorer sends your question, editor SQL and table/column names (no row data) to answer it.' },
        cts.token,
      );
      for await (const text of res.text) {
        onChunk(text);
      }
      used = model.name;
    }
    return used;
  } finally {
    if (pending.get(key) === cts) { pending.delete(key); }
    cts.dispose();
  }
}
