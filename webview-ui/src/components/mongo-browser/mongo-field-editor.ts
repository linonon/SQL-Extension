import { convertShellToJson } from '../../utils/mongo-shell-to-json';
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

// 把输入文本转回原字段类型. 严格校验, 失败回退原值 (不静默写 0 / false), 避免数据损坏.
export function coerceToType(original: unknown, text: string): unknown {
  if (typeof original === 'number') {
    const t = text.trim();
    // 空 / 非纯数字 (0x / 1e / abc) 回退原值; "0" 等合法值正常解析
    if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) { return original; }
    // 超安全整数用 {$numberLong} 不丢精度 (与 coerceValue 一致)
    if (/^-?\d+$/.test(t) && !Number.isSafeInteger(Number(t))) { return { $numberLong: t }; }
    const n = Number(t);
    return Number.isFinite(n) ? n : original;
  }
  if (typeof original === 'boolean') {
    // 归一大小写与前后空白: "TRUE" / " true " 视为合法; 真非法输入仍回退原值, 不静默写反值
    const t = text.trim().toLowerCase();
    if (t === 'true') { return true; }
    if (t === 'false') { return false; }
    return original;
  }
  return text;
}

// 顶层字段 (排除 _id), 标记可编辑性
export function documentToFields(doc: Record<string, unknown>): FieldDescriptor[] {
  return Object.entries(doc)
    .filter(([key]) => key !== '_id')
    .map(([key, value]) => ({ key, value, editable: isEditableLeaf(value) }));
}

// 按叶子转换: 只把"真正的 shell-tag 字符串" (detectLeafType 判为非 string, 来自 deepFormatValue)
// 还原为 EJSON; 普通字符串/标量原样保留. 递归处理 object/array.
// 不对整篇文档跑正则 (那会把用户字面字符串如 'ObjectId("xyz")' 误转或让 JSON.parse 崩溃).
export function convertTags(value: unknown): unknown {
  if (typeof value === 'string') {
    if (detectLeafType(value) !== 'string') {
      return JSON.parse(convertShellToJson(value));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(convertTags);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = convertTags(v);
    }
    return out;
  }
  return value;
}
