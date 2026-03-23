# Fuzzy Filter for DatabaseBrowser Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DatabaseBrowser 的搜索栏从 substring match 升级为 scoring-based fuzzy match, 支持非连续字符匹配并按相关度排序.

**Architecture:** 新建 `fuzzy-score.ts` 工具函数, 实现 fuzzy match + scoring (连续匹配, word boundary, 开头匹配加权). `filterDatabases` 调用 `fuzzyScore` 替代 `includes`, 结果按分数降序排列.

**Tech Stack:** TypeScript, React

**Spec:** N/A (single function change)

---

## File Structure

**New files:**
- `webview-ui/src/utils/fuzzy-score.ts` -- fuzzy match 算法, 纯函数, 无依赖
- `webview-ui/src/utils/fuzzy-score.test.ts` -- 单元测试

**Modified files:**
- `webview-ui/src/components/db-browser/DatabaseObjectList.tsx:38-66` -- `filterDatabases` 函数替换为 fuzzy 版本

---

## Chunk 1: Fuzzy Score + Integration

### Task 1: Create fuzzy-score utility

**Files:**
- Create: `webview-ui/src/utils/fuzzy-score.ts`
- Create: `webview-ui/src/utils/fuzzy-score.test.ts`

- [ ] **Step 1: Write tests for fuzzyScore**

```typescript
// webview-ui/src/utils/fuzzy-score.test.ts
import { describe, it, expect } from 'vitest';
import { fuzzyScore } from './fuzzy-score';

describe('fuzzyScore', () => {
  it('returns 0 for empty pattern', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('returns -1 for no match', () => {
    expect(fuzzyScore('xyz', 'abc')).toBe(-1);
  });

  it('matches exact substring', () => {
    expect(fuzzyScore('user', 'users')).toBeGreaterThan(0);
  });

  it('matches non-contiguous characters', () => {
    // u...s...r matches user_stories
    expect(fuzzyScore('usr', 'user_stories')).toBeGreaterThan(0);
  });

  it('scores exact prefix higher than mid-word match', () => {
    const prefixScore = fuzzyScore('user', 'user_table');
    const midScore = fuzzyScore('user', 'super_user');
    expect(prefixScore).toBeGreaterThan(midScore);
  });

  it('scores consecutive match higher than scattered match', () => {
    const consecutive = fuzzyScore('log', 'login');
    const scattered = fuzzyScore('log', 'loading_config');
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('scores word boundary match higher than mid-word', () => {
    // "ct" matching "create_table" at boundaries vs "factory" mid-word
    const boundary = fuzzyScore('ct', 'create_table');
    const midWord = fuzzyScore('ct', 'factory');
    expect(boundary).toBeGreaterThan(midWord);
  });

  it('is case insensitive', () => {
    expect(fuzzyScore('USER', 'user_table')).toBeGreaterThan(0);
    expect(fuzzyScore('user', 'USER_TABLE')).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npx vitest run webview-ui/src/utils/fuzzy-score.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement fuzzyScore**

```typescript
// webview-ui/src/utils/fuzzy-score.ts

// scoring weights
const SCORE_CONSECUTIVE = 8;
const SCORE_WORD_BOUNDARY = 6;
const SCORE_FIRST_CHAR = 10;
const SCORE_DEFAULT = 1;
const PENALTY_GAP_START = -3;
const PENALTY_GAP = -1;

// 判断 pos 是否在 word boundary (字符串开头, _ 后, - 后, camelCase 大写)
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
      // 匹配
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
      // gap penalty
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npx vitest run webview-ui/src/utils/fuzzy-score.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/utils/fuzzy-score.ts webview-ui/src/utils/fuzzy-score.test.ts
git commit -m "feat(db-browser): add scoring-based fuzzy match utility"
```

---

### Task 2: Integrate fuzzyScore into filterDatabases

**Files:**
- Modify: `webview-ui/src/components/db-browser/DatabaseObjectList.tsx:38-66`

- [ ] **Step 1: Replace filterDatabases with fuzzy version**

将 `DatabaseObjectList.tsx` 顶部添加 import:

```typescript
import { fuzzyScore } from '../../utils/fuzzy-score';
```

替换整个 `filterDatabases` 函数 (line 38-66) 为:

```typescript
interface ScoredDatabase {
  readonly db: DatabaseInfo;
  readonly score: number;
  readonly tables: readonly TableInfo[];
}

function filterDatabases(
  databases: readonly DatabaseInfo[],
  filterText: string
): readonly DatabaseInfo[] {
  if (!filterText) { return databases; }
  const dotIdx = filterText.indexOf('.');
  if (dotIdx >= 0) {
    // db.table 格式: dot 前 fuzzy 匹配 db name, dot 后 fuzzy 匹配 table name
    const dbPattern = filterText.slice(0, dotIdx);
    const tablePattern = filterText.slice(dotIdx + 1);
    return databases
      .filter((d) => !dbPattern || fuzzyScore(dbPattern, d.name) > 0)
      .map((d) => ({
        ...d,
        tables: !tablePattern
          ? d.tables
          : d.tables.filter((t) => fuzzyScore(tablePattern, t.name) > 0),
      }))
      .filter((d) => d.tables.length > 0);
  }
  // 单关键字: fuzzy 匹配 db name 或 table name, 按最高分排序
  const scored: ScoredDatabase[] = [];
  for (const d of databases) {
    const dbScore = fuzzyScore(filterText, d.name);
    const matchedTables = d.tables
      .map((t) => ({ table: t, score: fuzzyScore(filterText, t.name) }))
      .filter((r) => r.score > 0);
    if (dbScore > 0) {
      // db name 匹配: 保留所有 tables
      scored.push({ db: d, score: dbScore, tables: d.tables });
    } else if (matchedTables.length > 0) {
      // table name 匹配: 只保留匹配的 tables, 取最高 table score
      const bestScore = Math.max(...matchedTables.map((r) => r.score));
      scored.push({ db: d, score: bestScore, tables: matchedTables.map((r) => r.table) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => ({ ...s.db, tables: s.tables }));
}
```

- [ ] **Step 2: Build webview**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension/webview-ui && npm run build`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/components/db-browser/DatabaseObjectList.tsx
git commit -m "feat(db-browser): upgrade filter to scoring-based fuzzy match"
```
