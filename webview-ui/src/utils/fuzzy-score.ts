// scoring weights
const SCORE_CONSECUTIVE = 8;
const SCORE_WORD_BOUNDARY = 6;
const SCORE_FIRST_CHAR = 10;
const SCORE_DEFAULT = 1;
const PENALTY_GAP_START = -3;
const PENALTY_GAP = -1;

function isWordBoundary(text: string, pos: number): boolean {
  if (pos === 0) { return true; }
  const prev = text[pos - 1];
  return prev === '_' || prev === '-' || prev === '.'
    || (prev >= 'a' && prev <= 'z' && text[pos] >= 'A' && text[pos] <= 'Z');
}

/**
 * 计算 pattern 对 text 的 fuzzy match 分数.
 * 返回 -1 表示不匹配, 0 表示空 pattern, >0 表示匹配 (越高越相关).
 */
export function fuzzyScore(pattern: string, text: string): number {
  if (!pattern) { return 0; }
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  if (p.length > t.length) { return -1; }

  let score = 0;
  let pi = 0;
  let lastMatchIdx = -1;
  let inGap = false;

  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] === p[pi]) {
      if (lastMatchIdx >= 0 && ti === lastMatchIdx + 1) {
        score += SCORE_CONSECUTIVE;
      } else if (isWordBoundary(text, ti)) {
        score += SCORE_WORD_BOUNDARY;
      } else {
        score += SCORE_DEFAULT;
      }
      if (pi === 0 && ti === 0) {
        score += SCORE_FIRST_CHAR;
      }
      if (inGap) {
        score += PENALTY_GAP_START;
        inGap = false;
      }
      lastMatchIdx = ti;
      pi++;
    } else {
      if (lastMatchIdx >= 0) {
        inGap = true;
        score += PENALTY_GAP;
      }
    }
  }

  return pi === p.length ? Math.max(score, 1) : -1;
}
