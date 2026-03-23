export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 在 text 中查找所有 pattern 的非重叠匹配位置.
 * 默认 case-insensitive.
 */
export function findMatches(text: string, pattern: string, caseSensitive = false): MatchRange[] {
  if (!pattern || !text) { return []; }
  const t = caseSensitive ? text : text.toLowerCase();
  const p = caseSensitive ? pattern : pattern.toLowerCase();
  const results: MatchRange[] = [];
  let pos = 0;
  while (pos <= t.length - p.length) {
    const idx = t.indexOf(p, pos);
    if (idx === -1) { break; }
    results.push({ start: idx, end: idx + p.length });
    pos = idx + p.length;
  }
  return results;
}
