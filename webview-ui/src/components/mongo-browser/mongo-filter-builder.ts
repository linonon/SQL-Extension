// 可视化 filter 构建器的纯逻辑: 条件行 -> MongoDB filter JSON.
// 单向 (builder -> filter 文本), 避免反向解析任意 filter 的复杂度.

export type FilterOp =
  | '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte'
  | '$in' | '$regex' | '$exists';

export interface Condition {
  readonly field: string;
  readonly op: FilterOp;
  readonly value: string;
}

export const FILTER_OPS: readonly { readonly op: FilterOp; readonly label: string }[] = [
  { op: '$eq', label: '=' },
  { op: '$ne', label: '≠' },
  { op: '$gt', label: '>' },
  { op: '$gte', label: '≥' },
  { op: '$lt', label: '<' },
  { op: '$lte', label: '≤' },
  { op: '$in', label: 'in (逗号分隔)' },
  { op: '$regex', label: 'contains (正则)' },
  { op: '$exists', label: 'exists' },
];

// 文本按字面量类型推断: 布尔 / 数字 / 否则字符串.
// 收紧数字判定 (M4): 前导零 / 0x / 1e / 非纯数字保字符串 (避免邮编/订单号被转数字而匹配不上);
// 超安全整数用 {$numberLong} 不丢精度.
export function coerceValue(text: string): unknown {
  if (text === 'true') { return true; }
  if (text === 'false') { return false; }
  const t = text.trim();
  if (/^-?\d+$/.test(t) && !/^-?0\d/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : { $numberLong: t };
  }
  if (/^-?\d+\.\d+$/.test(t)) {
    return Number(t);
  }
  return text;
}

function conditionToObject(cond: Condition): Record<string, unknown> {
  const { field, op, value } = cond;
  switch (op) {
    case '$eq':
      return { [field]: coerceValue(value) };
    case '$in':
      return { [field]: { $in: value.split(',').map((s) => coerceValue(s.trim())) } };
    case '$regex':
      return { [field]: { $regex: value, $options: 'i' } };
    case '$exists':
      return { [field]: { $exists: value !== 'false' } };
    default:
      return { [field]: { [op]: coerceValue(value) } };
  }
}

export function buildFilterFromConditions(conditions: readonly Condition[]): string {
  const valid = conditions.filter((c) => c.field.trim() !== '');
  if (valid.length === 0) { return '{}'; }
  if (valid.length === 1) { return JSON.stringify(conditionToObject(valid[0])); }
  return JSON.stringify({ $and: valid.map(conditionToObject) });
}
