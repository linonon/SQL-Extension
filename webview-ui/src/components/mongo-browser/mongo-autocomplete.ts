// MongoDB filter 补全逻辑: 上下文检测 + 候选项过滤

export interface MongoAutocompleteContext {
  readonly triggerType: 'field' | 'operator' | 'function' | null;
  readonly prefix: string;
}

const MONGO_OPERATORS: readonly string[] = [
  // 比较
  '$eq', '$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$nin',
  // 元素 / 求值
  '$exists', '$type', '$regex', '$options', '$mod', '$expr', '$text', '$search',
  // 逻辑
  '$and', '$or', '$not', '$nor',
  // 数组
  '$elemMatch', '$size', '$all',
];

const MONGO_FUNCTIONS: readonly string[] = [
  'ObjectId', 'ISODate', 'NumberLong', 'NumberInt', 'NumberDecimal',
  'Long', 'Int32', 'Decimal128', 'MinKey', 'MaxKey',
];

// 判断 idx 位置的字符是否被转义 (统计前面连续反斜杠数量)
function isEscaped(str: string, idx: number): boolean {
  let count = 0;
  let j = idx - 1;
  while (j >= 0 && str[j] === '\\') {
    count++;
    j--;
  }
  return count % 2 === 1;
}

// 判断 cursor 是否在 JSON 字符串值内 (数双引号奇偶)
function isInsideString(before: string): boolean {
  let count = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '"' && !isEscaped(before, i)) {
      count++;
    }
  }
  return count % 2 === 1;
}

// 判断 cursor 是否在 JSON key 位置
// 从末尾往前找同层的 { 或 ,, 然后检查该 segment 中是否有不在字符串内的 :
function isInKeyPosition(before: string): boolean {
  let depth = 0;
  let arrayDepth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (ch === '}') { depth++; continue; }
    if (ch === ']') { arrayDepth++; continue; }
    if (ch === '[') {
      if (arrayDepth > 0) { arrayDepth--; continue; }
      // 裸 [ 内不是 key 位置
      return false;
    }
    if (ch === '{') {
      if (depth > 0) { depth--; continue; }
      const segment = before.slice(i + 1);
      return !hasUnquotedColon(segment);
    }
    if (ch === ',' && depth === 0 && arrayDepth === 0) {
      const segment = before.slice(i + 1);
      return !hasUnquotedColon(segment);
    }
  }
  return false;
}

// 检查 segment 中是否有不在字符串内的冒号
function hasUnquotedColon(segment: string): boolean {
  let inStr = false;
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] === '"' && !isEscaped(segment, i)) {
      inStr = !inStr;
    }
    if (!inStr && segment[i] === ':') {
      return true;
    }
  }
  return false;
}

// 提取当前输入的标识符前缀 (引号内的文本或裸字)
// 支持嵌套字段路径如 address.city
function extractFieldPrefix(before: string): string {
  const quotedMatch = before.match(/"([\w.]*)$/);
  if (quotedMatch) return quotedMatch[1];
  const bareMatch = before.match(/([\w.]+)$/);
  return bareMatch ? bareMatch[1] : '';
}

// 数组只取前几个子文档采样: 子文档数组各元素字段基本一致; 跳过 null / 标量, 定长槽位数组常以 null 占位
const ARRAY_SAMPLE = 5;
// 候选上限: 大文档 (如配置集合) 的字段路径可达上万条
const MAX_COMPLETION_ITEMS = 50;

// 从文档数组递归提取所有字段路径; 子文档数组按同一路径 (不带下标) 往下走, 与 Mongo 的点路径查询一致
// [{ name: "a", bag: { items: [{ cnt: 1 }] } }] -> ["bag", "bag.items", "bag.items.cnt", "name"]
export function extractFieldPaths(
  rows: readonly Record<string, unknown>[],
): readonly string[] {
  const paths = new Set<string>();
  function walk(val: unknown, prefix: string): void {
    if (Array.isArray(val)) {
      const objects = val.filter((el) => el !== null && typeof el === 'object');
      for (const el of objects.slice(0, ARRAY_SAMPLE)) { walk(el, prefix); }
      return;
    }
    if (val === null || typeof val !== 'object') { return; }
    for (const [key, child] of Object.entries(val)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.add(path);
      walk(child, path);
    }
  }
  for (const row of rows) { walk(row, ''); }
  return [...paths].sort();
}

export function getMongoAutocompleteContext(
  text: string,
  cursorPos: number,
): MongoAutocompleteContext {
  const before = text.slice(0, cursorPos);

  if (before.length === 0) {
    return { triggerType: null, prefix: '' };
  }

  // 字符串值内不触发
  if (isInsideString(before)) {
    // 排除 key 位置的引号 -- key 引号内应该触发 field 补全
    const lastQuoteIdx = before.lastIndexOf('"');
    if (lastQuoteIdx >= 0) {
      const beforeQuote = before.slice(0, lastQuoteIdx);
      if (isInKeyPosition(beforeQuote)) {
        const prefix = before.slice(lastQuoteIdx + 1);
        // key 以 $ 开头是 operator (如 "$gt")
        if (prefix.startsWith('$')) {
          return { triggerType: 'operator', prefix };
        }
        return { triggerType: 'field', prefix };
      }
    }
    return { triggerType: null, prefix: '' };
  }

  // 操作符补全: $xxx
  const opMatch = before.match(/\$(\w*)$/);
  if (opMatch) {
    return { triggerType: 'operator', prefix: '$' + opMatch[1] };
  }

  // 字段名补全: 在 key 位置
  if (isInKeyPosition(before)) {
    return { triggerType: 'field', prefix: extractFieldPrefix(before) };
  }

  // value 位置的字母前缀 -> BSON 函数补全
  const funcMatch = before.match(/[A-Za-z]\w*$/);
  if (funcMatch) {
    return { triggerType: 'function', prefix: funcMatch[0] };
  }

  return { triggerType: null, prefix: '' };
}

export function getMongoCompletionItems(
  ctx: MongoAutocompleteContext,
  fieldNames: readonly string[],
): readonly string[] {
  if (ctx.triggerType === null) return [];

  const prefix = ctx.prefix.toLowerCase();

  if (ctx.triggerType === 'field') {
    const matched = prefix ? fieldNames.filter((f) => f.toLowerCase().startsWith(prefix)) : fieldNames;
    // 截断前浅层优先 (稳定排序, 同层保持原序): 大文档的深层路径不会把顶层字段挤出候选
    const depth = (f: string) => f.split('.').length;
    return [...matched].sort((a, b) => depth(a) - depth(b)).slice(0, MAX_COMPLETION_ITEMS);
  }

  if (ctx.triggerType === 'operator') {
    return MONGO_OPERATORS.filter((op) => op.startsWith(prefix));
  }

  if (ctx.triggerType === 'function') {
    const lower = prefix.toLowerCase();
    return MONGO_FUNCTIONS.filter((f) => f.toLowerCase().startsWith(lower));
  }

  return [];
}
