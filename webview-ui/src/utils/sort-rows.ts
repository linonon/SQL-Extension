import type { SortState } from './sql-builder';

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const INTEGER_RE = /^-?\d+$/;

function isNumeric(v: unknown): boolean {
  return typeof v === 'number' || (typeof v === 'string' && NUMBER_RE.test(v));
}

// 整数串按 BigInt 比 (BIGINT 以字符串返回, 超出 2^53 时 Number 会丢精度), 其余按 Number 比
function compareNumeric(a: unknown, b: unknown): number {
  const sa = String(a);
  const sb = String(b);
  if (INTEGER_RE.test(sa) && INTEGER_RE.test(sb)) {
    const x = BigInt(sa);
    const y = BigInt(sb);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  return Number(sa) - Number(sb);
}

// 在内存里排已加载的行: 稳定排序, NULL 恒在最后; 该列非 NULL 值全是数字 (含 BIGINT / DECIMAL 字符串) 时按数值比
export function sortLoadedRows<T extends Record<string, unknown>>(rows: readonly T[], sort: SortState): T[] {
  const { column } = sort;
  const dir = sort.direction === 'ASC' ? 1 : -1;
  const present = rows.map((r) => r[column]).filter((v) => v !== null && v !== undefined);
  const numeric = present.length > 0 && present.every(isNumeric);
  return [...rows].sort((ra, rb) => {
    const a = ra[column];
    const b = rb[column];
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
    return dir * (numeric ? compareNumeric(a, b) : String(a).localeCompare(String(b)));
  });
}
