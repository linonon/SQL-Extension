export type LeafType =
  | 'ObjectId' | 'Date' | 'Long' | 'Int' | 'Decimal128' | 'MinKey' | 'MaxKey'
  | 'string' | 'number' | 'boolean' | 'null';

const TAG_PATTERNS: ReadonlyArray<{ re: RegExp; type: LeafType }> = [
  { re: /^ObjectId\("[0-9a-fA-F]{24}"\)$/, type: 'ObjectId' },
  { re: /^ISODate\(".*"\)$/, type: 'Date' },
  { re: /^NumberLong\(".*"\)$/, type: 'Long' },
  { re: /^NumberInt\(.*\)$/, type: 'Int' },
  { re: /^NumberDecimal\(".*"\)$/, type: 'Decimal128' },
  { re: /^MinKey\(\)$/, type: 'MinKey' },
  { re: /^MaxKey\(\)$/, type: 'MaxKey' },
];

// 判定一个叶子值 (标量或 shell-tag 字符串) 的展示类型, 供 badge 与配色用.
export function detectLeafType(value: unknown): LeafType {
  if (value === null || value === undefined) { return 'null'; }
  if (typeof value === 'number') { return 'number'; }
  if (typeof value === 'boolean') { return 'boolean'; }
  if (typeof value === 'string') {
    for (const { re, type } of TAG_PATTERNS) {
      if (re.test(value)) { return type; }
    }
    return 'string';
  }
  return 'string';
}
