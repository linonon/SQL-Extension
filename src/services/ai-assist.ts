import * as vscode from 'vscode';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PREFIX, claudeCodeAvailable, runClaudeCode } from './claude-code.js';
import type { SchemaColumn } from '../types/query.js';
import type { ExtensionMessage, MongoQueryInputs } from '../types/messages.js';

// schema 序列化上限: 大库表多时截断, 防 prompt 超出模型上下文
const SCHEMA_CHAR_LIMIT = 30_000;

// 按顺序给每项装入第一个放得下的写法 (总长不超过 SCHEMA_CHAR_LIMIT); 一个写法都放不下的项跳过并计数, 后面放得下的照装
function fitBlocks(items: readonly (readonly string[])[], noun: string): string {
  const out: string[] = [];
  let size = 0;
  let dropped = 0;
  for (const tries of items) {
    const block = tries.find((b) => size + b.length <= SCHEMA_CHAR_LIMIT);
    if (block === undefined) {
      dropped++;
      continue;
    }
    out.push(block);
    size += block.length + 1;
  }
  if (dropped > 0) { out.push(`... (${dropped} more ${noun} truncated)`); }
  return out.join('\n');
}

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
  return fitBlocks([
    ...entries.filter(([t]) => mentioned(t)).map((e) => [detailed(e), namesOnly(e)]),
    ...entries.filter(([t]) => !mentioned(t)).map((e) => [namesOnly(e)]),
  ], 'tables');
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

export interface MongoAiAskInput extends MongoQueryInputs {
  readonly database: string;
  readonly collection: string;
  readonly question: string;
  // 采样文档的字段路径 -> BSON 类型, 浅层在前 (只有 key 与类型, 没有值)
  readonly fields: readonly (readonly [string, readonly string[]])[];
  // 上一次 Apply 的查询失败时的报错
  readonly lastError?: string;
  readonly now: Date;
  // 用户所在时区名 (IANA)
  readonly timeZone: string;
}

/** Mongo 浏览器 Ask AI 的 prompt: 只生成当前集合的 find 查询 (五个输入框), 不发任何文档值 */
export function buildMongoAiPrompt(input: MongoAiAskInput): string {
  const fields = fitBlocks(input.fields.map(([path, types]) => [`${path}: ${types.join(', ')}`]), 'field paths');
  const ms = input.now.getTime();
  return [
    `You are a MongoDB assistant embedded in a document browser. Current collection: ${input.database}.${input.collection}.`,
    'Answer concisely in the language of the question.',
    '',
    'The browser runs the query as $match (Filter) -> $sort (Sort) -> $project (Projection) -> $skip (Skip) -> $limit (Limit).',
    '- Sort runs before Projection: it can only use stored fields, not fields computed in Projection.',
    '- Limit is the page size: the Next button keeps paging through the rest of the result. Skip is the starting offset.',
    '- The browser is read-only for this feature: never produce update / insert / delete commands.',
    '',
    'When the answer involves a query, give one fenced block per input box, with the box name as the info string:',
    '```filter, ```sort, ```projection, ```limit, ```skip. Together the blocks are the complete query: a box without',
    'a block is cleared (Limit back to 50, Skip back to 0), so repeat any part of the current inputs you want to keep. Example:',
    '```filter',
    '{"level": {"$gte": 30}, "lastLogin": {"$gte": ISODate("2026-10-01T00:00:00Z")}}',
    '```',
    '```sort',
    '{"level": -1}',
    '```',
    '```limit',
    '20',
    '```',
    'If the question needs grouping or other aggregation stages, say the browser only runs the query above and give the',
    'pipeline in a ```javascript block for the user to copy; it is never run here.',
    '',
    'Syntax for Filter / Sort / Projection (one object each):',
    '- Prefer double-quoted JSON keys and strings; the parser also accepts mongosh bare keys and single quotes.',
    '- Numbers unquoted, never as strings; large integers (Long) can be written bare.',
    '- Dates as ISODate("2026-10-01T00:00:00Z") with an explicit zone (Z or +08:00), never date strings.',
    '- ObjectId("<24 hex>") for ObjectId fields other than _id (a 24-hex string on _id is converted automatically).',
    '- No comments, no regex literals (use {"$regex": "..."}), no trailing commas.',
    '- Use $elemMatch when several conditions must hit the same array element.',
    'Limit and Skip are plain non-negative integers.',
    '',
    'Field paths and BSON types from a random sample of documents (values are not included; other fields may exist).',
    'Fields of array elements use the array\'s path (items.id is the id of each element of items).',
    '<n> stands for numeric keys and <id> for 24-hex keys: these are dynamic map keys, and find cannot wildcard them,',
    'so a condition on them needs a concrete key from the question.',
    fields || '(no documents sampled)',
    '',
    'Current inputs (raw text):',
    ...(['filter', 'sort', 'projection', 'limit', 'skip'] as const).map((box) => `${box}: ${input[box] || '(empty)'}`),
    ...(input.lastError ? ['', 'Last error (from the last applied query, which may differ from the current inputs):', input.lastError] : []),
    '',
    `Now: ${input.now.toISOString()} (user time zone ${input.timeZone}; epoch seconds ${Math.floor(ms / 1000)}; epoch milliseconds ${ms}).`,
    'For epoch-number time fields, pick seconds or milliseconds from the field name and say which you assumed.',
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
 * 设置是可用的 Copilot 模型时 effectiveModelId 必然选它, 这时不起 `claude auth status` 子进程
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
 * getPrompt 与模型解析并行, 都在登记取消之后才执行: 取 schema / 采样期间的 Stop / Close 也能拦住请求.
 */
async function runAiAsk(
  key: object,
  getPrompt: () => Promise<string>,
  onChunk: (text: string) => void,
): Promise<string> {
  cancelAiAsk(key);
  const cts = new vscode.CancellationTokenSource();
  pending.set(key, cts);
  try {
    const [prompt, { chosen, copilot, claudeBin }] = await Promise.all([getPrompt(), resolveAiModel()]);
    if (cts.token.isCancellationRequested) { throw new vscode.CancellationError(); }
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
        { justification: 'Database Explorer sends your question, the current query, its last error and the schema (table / field names, types and comments; no row or document values) to answer it.' },
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

/**
 * 一次提问的完整回执: 回答分段发 aiChunk, 结束发 aiDone (带所用模型或错误), 都带 webview 的提问 id.
 * key 与 aiCancel / panel 关闭时 cancelAiAsk 用的是同一个 (panel). panel 关闭后 postMessage 会抛, 回执丢掉即可
 */
export async function streamAiAnswer(
  key: object,
  id: string,
  post: (msg: ExtensionMessage) => void,
  getPrompt: () => Promise<string>,
): Promise<void> {
  const send = (msg: ExtensionMessage) => { try { post(msg); } catch { /* panel 已关闭 */ } };
  try {
    const model = await runAiAsk(key, getPrompt, (text) => send({ type: 'aiChunk', id, text }));
    send({ type: 'aiDone', id, model });
  } catch (err) {
    send({ type: 'aiDone', id, error: err instanceof Error ? err.message : String(err) });
  }
}
