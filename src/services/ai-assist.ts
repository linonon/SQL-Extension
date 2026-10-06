import * as vscode from 'vscode';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PREFIX, claudeCodeAvailable, runClaudeCode } from './claude-code.js';
import type { SchemaColumn } from '../types/query.js';

// schema 序列化上限: 大库表多时截断, 防 prompt 超出模型上下文
const SCHEMA_CHAR_LIMIT = 30_000;

export interface AiAskInput {
  readonly dialect: string;
  readonly database: string;
  readonly schema: Record<string, readonly SchemaColumn[]>;
  readonly question: string;
  readonly sql: string;
  readonly selection: string;
  // 编辑器上一次执行失败时的报错
  readonly lastError?: string;
}

// 问题 / SQL 里提到的表排前面且逐列带类型与注释 (枚举含义常写在注释里), 其余表只列列名;
// 再按整表装入上限: 提到的表详情放不下 (宽表) 退回只列列名, 仍放不下才跳过, 后面放得下的表照装
function schemaLines(input: AiAskInput): string {
  const words = new Set(`${input.question}\n${input.sql}\n${input.selection}`.toLowerCase().match(/[a-z0-9_$]+/g));
  const mentioned = (t: string) => words.has(t.toLowerCase());
  const entries = Object.entries(input.schema);
  const namesOnly = ([t, cols]: [string, readonly SchemaColumn[]]) => `${t}(${cols.map((c) => c.name).join(', ')})`;
  const detailed = ([t, cols]: [string, readonly SchemaColumn[]]) => [
    `${t}:`,
    ...cols.map((c) => {
      const comment = c.comment.replace(/\s+/g, ' ').trim();
      return `  ${c.name} ${c.type}${comment ? ` -- ${comment}` : ''}`;
    }),
  ].join('\n');
  // 每张表依次尝试的写法
  const forms = [
    ...entries.filter(([t]) => mentioned(t)).map((e) => [detailed(e), namesOnly(e)]),
    ...entries.filter(([t]) => !mentioned(t)).map((e) => [namesOnly(e)]),
  ];
  const out: string[] = [];
  let size = 0;
  let dropped = 0;
  for (const tries of forms) {
    const block = tries.find((b) => size + b.length <= SCHEMA_CHAR_LIMIT);
    if (block === undefined) {
      dropped++;
      continue;
    }
    out.push(block);
    size += block.length + 1;
  }
  if (dropped > 0) { out.push(`... (${dropped} more tables truncated)`); }
  return out.join('\n');
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
    'Schema (tables mentioned below list "column type -- comment" per line; other tables are table(columns)):',
    schemaText || '(empty)',
    '',
    'Editor content:',
    input.sql || '(empty)',
    ...(input.selection ? ['', 'Selected SQL:', input.selection] : []),
    ...(input.lastError ? ['', 'Last error (the previous execution in this editor failed with):', input.lastError] : []),
    '',
    'Question:',
    input.question,
  ].join('\n');
}

const MODEL_SETTING = 'ai.model';

function configuredModelId(): string {
  return vscode.workspace.getConfiguration('sqlext').get<string>(MODEL_SETTING, '');
}

/**
 * 实际使用的模型: 设置值在可用列表里就用它, 否则 (未设置 / Claude Code 未登录 / Copilot 模型下线) 用列表第一个.
 * 下拉框的选中项与提问所用模型都由它决定, 两边不会不一致
 */
export function effectiveModelId(setting: string, models: readonly { readonly id: string }[]): string {
  return models.some(m => m.id === setting) ? setting : (models[0]?.id ?? '');
}

const copilotModels = () => vscode.lm.selectChatModels({ vendor: 'copilot' }).then(ms => ms, () => []);

// 本机已登录的 Claude Code 在前 (默认优先), Copilot 兜底
function modelList(copilot: readonly vscode.LanguageModelChat[], claudeBin: string | null) {
  return [
    ...(claudeBin ? CLAUDE_CODE_MODELS.map(m => ({ id: CLAUDE_CODE_PREFIX + m.alias, name: m.name })) : []),
    ...copilot.map(m => ({ id: m.id, name: m.name })),
  ];
}

/** 可用模型与实际会用的那个 (selected) */
export async function listAiModels(): Promise<{ models: { id: string; name: string }[]; selected: string }> {
  const [copilot, claudeBin] = await Promise.all([copilotModels(), claudeCodeAvailable()]);
  const models = modelList(copilot, claudeBin);
  return { models, selected: effectiveModelId(configuredModelId(), models) };
}

/**
 * 提问实际用的模型, 与 listAiModels 的 selected 一致.
 * 设置是可用的 Copilot 模型时 effectiveModelId 必然选它, 不再起 `claude auth status` 子进程
 */
export async function resolveAiModel() {
  const setting = configuredModelId();
  const copilotP = copilotModels();
  const copilotPick = !!setting && !setting.startsWith(CLAUDE_CODE_PREFIX) && (await copilotP).some(m => m.id === setting);
  const [copilot, claudeBin] = await Promise.all([copilotP, copilotPick ? null : claudeCodeAvailable()]);
  return { chosen: effectiveModelId(setting, modelList(copilot, claudeBin)), copilot, claudeBin };
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
 * 按 effectiveModelId 选模型回答 (Copilot 模型或本机 Claude Code), 流式回调 onChunk; 返回所用模型名.
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
    const { chosen, copilot, claudeBin } = await resolveAiModel();
    if (!chosen) {
      throw new Error('No AI model available: log in to Claude Code (run `claude auth login`), or install / sign in to GitHub Copilot.');
    }
    let used: string;
    if (chosen.startsWith(CLAUDE_CODE_PREFIX)) {
      const ac = new AbortController();
      cts.token.onCancellationRequested(() => ac.abort());
      used = await runClaudeCode(claudeBin!, chosen.slice(CLAUDE_CODE_PREFIX.length), prompt, ac.signal, onChunk);
    } else {
      const model = copilot.find(m => m.id === chosen)!;
      const res = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        { justification: 'Database Explorer sends your question, editor SQL, its last error and table/column names, types and comments (no row data) to answer it.' },
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
