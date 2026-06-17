import { jsonToShell, convertShellToJson } from '../../utils/mongo-shell-to-json';
import { detectLeafType } from './mongo-leaf-type';

// 结构化字段编辑器的纯逻辑.

export interface FieldDescriptor {
  readonly key: string;
  readonly value: unknown;
  readonly editable: boolean;
}

// 仅标量叶子可在字段编辑器里直接改: string(非 shell-tag) / number / boolean.
// shell-tag (ObjectId/Date/...) / object / array / null -> 只读 (用 JSON 模式编辑).
export function isEditableLeaf(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'boolean') { return true; }
  if (typeof value === 'string') { return detectLeafType(value) === 'string'; }
  return false;
}

// 把输入文本转回原字段类型 (number/boolean 保留, 否则字符串)
export function coerceToType(original: unknown, text: string): unknown {
  if (typeof original === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : original;
  }
  if (typeof original === 'boolean') { return text === 'true'; }
  return text;
}

// 顶层字段 (排除 _id), 标记可编辑性
export function documentToFields(doc: Record<string, unknown>): FieldDescriptor[] {
  return Object.entries(doc)
    .filter(([key]) => key !== '_id')
    .map(([key, value]) => ({ key, value, editable: isEditableLeaf(value) }));
}

// 把含 shell-tag 字符串叶子的文档转成 EJSON (供 onSave -> replaceOne).
// 复用 JSON 编辑器同一序列化链: doc -> JSON -> shell 文本 -> EJSON.
export function docToEjson(doc: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(convertShellToJson(jsonToShell(JSON.stringify(doc)))) as Record<string, unknown>;
}
