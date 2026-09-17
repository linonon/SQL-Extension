# MySQL Multi-statement Execute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MySQL QueryEditor 支持按 `;` 顺序执行多语句 (遇错即停 + 紧凑逐条摘要), 工具栏只读显示当前 database, 有选区时只跑选区.

**Architecture:** Host 侧抽出共享 `splitSqlStatements`, `executeQuery` 在 `driverType === 'mysql'` 时逐条调用现有 `executeCancellable` (与 `alterTable` 同模式), 回执新消息 `queryBatchResult`; 非 MySQL 保持原 `queryResult` 单次执行. Webview QueryEditor 解析选区 SQL、渲染只读 DB 徽章与紧凑摘要列表, 结果表格展示「最后一条成功且带 result set」的数据.

**Tech Stack:** TypeScript, Vitest, React, VS Code webview messaging, mysql2 (不开启 `multiStatements`)

**Spec:** `docs/superpowers/specs/2026-09-17-mysql-multi-statement-execute-design.md`

## Global Constraints

- MySQL only for multi-statement batch path; PostgreSQL/other drivers keep single-shot `queryResult`
- Do **not** set `multiStatements: true` on the MySQL pool
- Do **not** wrap the batch in `driver.transaction`
- Stop on first error; mark remaining statements `skipped`
- Compact summary list (layout A) — no expand/collapse panel in this change
- Read-only database badge only — no switcher
- Selection overrides full buffer for Execute text
- Deletes/destructive confirm stay on extension host modal (`isWholeTableWrite`)
- Generated SQL conventions unchanged (no database qualify on USE path)
- After `src/` changes: root `npm run build`; after `webview-ui/src/` changes: `cd webview-ui && npm run build`
- Commits: Angular `type(scope): subject` (Chinese or English OK); task done => commit
- Live extension may load from installed `~/.vscode` copy — rebuild ≠ live until sync/repackage

---

## File Structure

**New files:**
- `webview-ui/src/components/query-editor/StatementSummaryList.tsx` — compact per-statement summary rows
- `webview-ui/src/components/query-editor/StatementSummaryList.test.tsx` — list rendering tests (vitest + testing-library)

**Modified files:**
- `src/utils/destructive-sql.ts` — export `splitSqlStatements`; implement `isWholeTableWrite` via it
- `src/utils/destructive-sql.test.ts` — tests for `splitSqlStatements`; keep existing `isWholeTableWrite` cases
- `src/types/messages.ts` — add `queryBatchResult` + `StatementResult` shape
- `webview-ui/src/types/messages.ts` — mirror types
- `src/providers/sql-message-handler.ts` — MySQL batch execute in `executeQuery`; empty batch on confirm cancel
- `src/providers/sql-message-handler.test.ts` — create if missing, or extend; cover batch stop-on-error (mock driver)
- `webview-ui/src/components/sql-editor/SqlEditor.tsx` — report selection changes
- `webview-ui/src/components/query-editor/QueryEditor.tsx` — selection SQL, badge, batch UI
- `webview-ui/src/styles/query-editor.css` — badge + summary list styles

**Out of scope files:** `mysql-driver.ts` pool options, PG driver, MCP/IPC query paths, Import SQL path

---

### Task 1: Shared `splitSqlStatements`

**Files:**
- Modify: `src/utils/destructive-sql.ts`
- Modify: `src/utils/destructive-sql.test.ts`

**Interfaces:**
- Consumes: existing private `stripCommentsAndStrings`
- Produces: `export function splitSqlStatements(sql: string): string[]`

- [ ] **Step 1: Write the failing tests**

Add to `src/utils/destructive-sql.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isWholeTableWrite, splitSqlStatements } from './destructive-sql';

describe('splitSqlStatements', () => {
  it('按分号切分并丢掉空段', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('字符串内分号不切分', () => {
    expect(splitSqlStatements("UPDATE t SET note = 'a;b';")).toEqual([
      "UPDATE t SET note = 'a;b'",
    ]);
  });

  it('注释内分号不切分', () => {
    expect(splitSqlStatements('SELECT 1 /* ; */ ; SELECT 2')).toEqual(['SELECT 1 /* ; */', 'SELECT 2']);
  });

  it('全空白返回空数组', () => {
    expect(splitSqlStatements('   ;  ;')).toEqual([]);
  });
});
```

Keep all existing `isWholeTableWrite` tests unchanged.

- [ ] **Step 2: Run tests to verify new ones fail**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npx vitest run src/utils/destructive-sql.test.ts`

Expected: FAIL — `splitSqlStatements` is not exported / not defined

- [ ] **Step 3: Implement `splitSqlStatements` and refactor `isWholeTableWrite`**

In `src/utils/destructive-sql.ts`:

```ts
export function splitSqlStatements(sql: string): string[] {
  return stripCommentsAndStrings(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isWholeTableWrite(sql: string): boolean {
  return splitSqlStatements(sql).some(isDestructiveStatement);
}
```

Note: after strip, comments are already removed, so the "注释内分号" test input becomes whitespace around `;` — adjust the test expectation if strip removes the comment entirely (preferred):

```ts
  it('块注释去掉后再按分号切', () => {
    expect(splitSqlStatements('SELECT 1 /* ; */ ; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/destructive-sql.test.ts`

Expected: PASS (including all previous `isWholeTableWrite` cases)

- [ ] **Step 5: Commit**

```bash
git add src/utils/destructive-sql.ts src/utils/destructive-sql.test.ts
git commit -m "refactor(sql): extract splitSqlStatements for multi-statement Execute"
```

---

### Task 2: Message types for `queryBatchResult`

**Files:**
- Modify: `src/types/messages.ts`
- Modify: `webview-ui/src/types/messages.ts`

**Interfaces:**
- Consumes: existing `ColumnInfo` import in both message files
- Produces: `StatementStatus`, `StatementResult`, `ExtensionMessage` variant `queryBatchResult`

- [ ] **Step 1: Add shared shape to extension host messages**

In `src/types/messages.ts`, near `queryResult`, add:

```ts
export type StatementStatus = 'ok' | 'error' | 'skipped';

export interface StatementResult {
  readonly index: number;
  readonly sql: string;
  readonly status: StatementStatus;
  readonly executionTime?: number;
  readonly affectedRows?: number;
  readonly columns?: ColumnInfo[];
  readonly rows?: Record<string, unknown>[];
  readonly error?: string;
}
```

Extend `ExtensionMessage` union:

```ts
  | { type: 'queryBatchResult'; statements: StatementResult[] }
```

- [ ] **Step 2: Mirror identical types in webview messages**

In `webview-ui/src/types/messages.ts`, add the same `StatementStatus`, `StatementResult`, and `queryBatchResult` variant (keep both trees in sync manually — project convention).

- [ ] **Step 3: Typecheck**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension && npm run lint`

Expected: PASS (or only pre-existing unrelated errors)

- [ ] **Step 4: Commit**

```bash
git add src/types/messages.ts webview-ui/src/types/messages.ts
git commit -m "feat(query): add queryBatchResult message type"
```

---

### Task 3: MySQL batch execute in `sql-message-handler`

**Files:**
- Modify: `src/providers/sql-message-handler.ts`
- Create or modify: `src/providers/sql-message-handler.test.ts` (if no file exists, create one with vitest mocks)

**Interfaces:**
- Consumes: `splitSqlStatements` from `../utils/destructive-sql.js`; `sanitizeErrorMessage`; `ctx.getDriver().executeCancellable`; `StatementResult`
- Produces: MySQL `executeQuery` posts `queryBatchResult`; non-MySQL keeps `queryResult`

- [ ] **Step 1: Write failing handler tests**

Create/extend `src/providers/sql-message-handler.test.ts` with a mock driver:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleSqlMessage, type SqlMessageContext } from './sql-message-handler';

function mockCtx(overrides: Partial<SqlMessageContext> & { posts?: unknown[]; driverType?: string }) {
  const posts: unknown[] = overrides.posts ?? [];
  const resultsQueue = (overrides as { resultsQueue?: Array<{ columns: unknown[]; rows: unknown[]; affectedRows: number; executionTime: number } | Error> }).resultsQueue ?? [];
  let i = 0;
  const driver = {
    driverType: overrides.driverType ?? 'mysql',
    executeCancellable: vi.fn((sql: string) => {
      const item = resultsQueue[i++];
      if (item instanceof Error) {
        return { promise: Promise.reject(item), cancel: vi.fn() };
      }
      return { promise: Promise.resolve(item), cancel: vi.fn() };
    }),
  };
  const pendingCancels = new Map();
  const ctx: SqlMessageContext = {
    getDriver: () => driver as never,
    queryService: {} as never,
    post: (msg) => { posts.push(msg); },
    panel: {} as never,
    pendingCancels,
    database: 'AGENT_NEW',
    getSchema: async () => ({}),
    ...overrides,
  };
  return { ctx, posts, driver, pendingCancels };
}

describe('executeQuery mysql batch', () => {
  it('两条都成功时回 queryBatchResult', async () => {
    const { ctx, posts } = mockCtx({
      resultsQueue: [
        { columns: [], rows: [], affectedRows: 0, executionTime: 1 },
        { columns: [], rows: [], affectedRows: 0, executionTime: 2 },
      ],
    });
    await handleSqlMessage({
      type: 'executeQuery',
      database: 'AGENT_NEW',
      sql: 'ALTER TABLE a ADD c INT; ALTER TABLE b ADD c INT;',
    }, ctx);
    const batch = posts.find((p) => (p as { type: string }).type === 'queryBatchResult') as {
      statements: Array<{ status: string; index: number }>;
    };
    expect(batch.statements).toHaveLength(2);
    expect(batch.statements.every((s) => s.status === 'ok')).toBe(true);
  });

  it('第二条失败则后续 skipped', async () => {
    const { ctx, posts } = mockCtx({
      resultsQueue: [
        { columns: [], rows: [], affectedRows: 0, executionTime: 1 },
        new Error('boom'),
      ],
    });
    await handleSqlMessage({
      type: 'executeQuery',
      database: 'AGENT_NEW',
      sql: 'SELECT 1; SELECT 2; SELECT 3;',
    }, ctx);
    const batch = posts.find((p) => (p as { type: string }).type === 'queryBatchResult') as {
      statements: Array<{ status: string }>;
    };
    expect(batch.statements.map((s) => s.status)).toEqual(['ok', 'error', 'skipped']);
  });
});
```

Adapt mocks to whatever vscode stub the repo already uses (see other `*.test.ts` under `src/providers/`). If `handleSqlMessage` imports `vscode` for the confirm dialog, stub `vscode.window.showWarningMessage` like existing tests.

- [ ] **Step 2: Run tests — expect fail**

Run: `npx vitest run src/providers/sql-message-handler.test.ts`

Expected: FAIL (still posts single `queryResult` or tests missing implementation)

- [ ] **Step 3: Implement MySQL batch branch**

In `sql-message-handler.ts` `case 'executeQuery'`:

1. Keep `isWholeTableWrite` confirm. On cancel, post `{ type: 'queryBatchResult', statements: [] }` when driver is mysql; for non-mysql keep prior empty `queryResult` **or** always use empty batch only for mysql path — prefer:

```ts
if (confirm !== 'Execute') {
  if (ctx.getDriver().driverType === 'mysql') {
    ctx.post({ type: 'queryBatchResult', statements: [] });
  } else {
    ctx.post({ type: 'queryResult', columns: [], rows: [], affectedRows: 0, executionTime: 0 });
  }
  return true;
}
```

2. If `driverType !== 'mysql'`: keep existing single `executeCancellable(message.sql, undefined, db)` + `queryResult` path.

3. If mysql:

```ts
const stmts = splitSqlStatements(message.sql);
const statements: StatementResult[] = [];
let stopped = false;
for (let i = 0; i < stmts.length; i++) {
  const sql = stmts[i];
  const index = i + 1;
  if (stopped) {
    statements.push({ index, sql, status: 'skipped' });
    continue;
  }
  const { promise, cancel } = ctx.getDriver().executeCancellable(sql, undefined, db);
  ctx.pendingCancels.set(ctx.panel, cancel);
  try {
    const result = await promise;
    statements.push({
      index,
      sql,
      status: 'ok',
      executionTime: result.executionTime,
      affectedRows: result.affectedRows,
      columns: result.columns,
      rows: result.rows,
    });
  } catch (err) {
    statements.push({
      index,
      sql,
      status: 'error',
      error: sanitizeErrorMessage(err),
    });
    stopped = true;
  } finally {
    ctx.pendingCancels.delete(ctx.panel);
  }
}
ctx.post({ type: 'queryBatchResult', statements });
```

If `stmts.length === 0`, post `{ type: 'queryBatchResult', statements: [] }`.

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run src/providers/sql-message-handler.test.ts src/utils/destructive-sql.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/sql-message-handler.ts src/providers/sql-message-handler.test.ts
git commit -m "feat(query): MySQL executeQuery runs statements sequentially"
```

---

### Task 4: SqlEditor selection + QueryEditor execute text

**Files:**
- Modify: `webview-ui/src/components/sql-editor/SqlEditor.tsx`
- Modify: `webview-ui/src/components/query-editor/QueryEditor.tsx`

**Interfaces:**
- Consumes: textarea `selectionStart` / `selectionEnd`
- Produces: `onSelectionChange?: (selectedText: string) => void` on `SqlEditor`; QueryEditor uses selection-or-full for `executeQuery`

- [ ] **Step 1: Extend SqlEditor props**

```ts
interface SqlEditorProps {
  // ...existing
  readonly onSelectionChange?: (selectedText: string) => void;
}
```

On `onSelect` / `onKeyUp` / `onMouseUp` of the textarea, call:

```ts
const start = textarea.selectionStart;
const end = textarea.selectionEnd;
const selected = start === end ? '' : value.slice(start, end);
onSelectionChange?.(selected);
```

- [ ] **Step 2: QueryEditor keeps selection and uses it on Execute**

```ts
const [selectedText, setSelectedText] = useState('');

const resolveSql = useCallback(() => {
  const trimmedSelection = selectedText.trim();
  if (trimmedSelection) return trimmedSelection;
  return sqlText.trim();
}, [selectedText, sqlText]);

const executeQuery = useCallback(() => {
  const trimmed = resolveSql();
  if (!trimmed) return;
  setExecuting(true);
  setSaveError(null);
  setResult(null);
  setBatchStatements(null); // added in Task 5
  lastSqlRef.current = trimmed;
  postMessage({ type: 'executeQuery', database, sql: trimmed });
}, [resolveSql, database, postMessage]);
```

Pass `onSelectionChange={setSelectedText}` into `SqlEditor`.

- [ ] **Step 3: Build webview**

Run: `cd /Users/linonon/Workspace/tools/SQL-Extension/webview-ui && npm run build`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/components/sql-editor/SqlEditor.tsx webview-ui/src/components/query-editor/QueryEditor.tsx
git commit -m "feat(query): Execute uses editor selection when present"
```

---

### Task 5: DB badge + compact statement summary UI

**Files:**
- Create: `webview-ui/src/components/query-editor/StatementSummaryList.tsx`
- Create: `webview-ui/src/components/query-editor/StatementSummaryList.test.tsx`
- Modify: `webview-ui/src/components/query-editor/QueryEditor.tsx`
- Modify: `webview-ui/src/styles/query-editor.css`

**Interfaces:**
- Consumes: `StatementResult[]` from `queryBatchResult`
- Produces: toolbar badge; summary list; grid shows last successful result set

- [ ] **Step 1: Write StatementSummaryList test**

```tsx
import { render, screen } from '@testing-library/react';
import { StatementSummaryList } from './StatementSummaryList';

it('renders ok/error/skipped rows', () => {
  render(
    <StatementSummaryList
      statements={[
        { index: 1, sql: 'ALTER TABLE a ADD c INT', status: 'ok', executionTime: 12, affectedRows: 0 },
        { index: 2, sql: 'ALTER TABLE b ADD c INT', status: 'error', error: 'syntax' },
        { index: 3, sql: 'ALTER TABLE c ADD c INT', status: 'skipped' },
      ]}
    />
  );
  expect(screen.getByText(/1 OK/i)).toBeTruthy();
  expect(screen.getByText(/2 ERR/i)).toBeTruthy();
  expect(screen.getByText(/3 skipped/i)).toBeTruthy();
});
```

- [ ] **Step 2: Implement StatementSummaryList**

Compact rows (no expand control):

```tsx
export function StatementSummaryList({ statements }: { readonly statements: readonly StatementResult[] }) {
  return (
    <div className="statement-summary-list">
      {statements.map((s) => (
        <div key={s.index} className={`statement-summary-row status-${s.status}`}>
          <div className="statement-summary-meta">
            <span className="statement-summary-status">
              {s.index}{' '}
              {s.status === 'ok' ? 'OK' : s.status === 'error' ? 'ERR' : 'skipped'}
            </span>
            {s.status === 'ok' && (
              <span className="statement-summary-stats">
                {s.executionTime ?? 0}ms · affected {s.affectedRows ?? 0}
              </span>
            )}
          </div>
          <div className="statement-summary-sql">{truncate(s.sql, 120)}</div>
          {s.status === 'error' && s.error ? (
            <div className="statement-summary-error">{s.error}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function truncate(sql: string, max: number): string {
  return sql.length <= max ? sql : `${sql.slice(0, max)}...`;
}
```

- [ ] **Step 3: Wire QueryEditor**

- State: `batchStatements: StatementResult[] | null`
- On `queryBatchResult`: set batchStatements; derive display grid from last `status === 'ok'` item that has `columns.length > 0` (or rows); clear legacy single `result.error` path for batch; setExecuting false
- Keep handling `queryResult` for non-batch (PG / autoExecute table browse still uses single path today — table open may still hit mysql batch if it goes through executeQuery; that is fine: one-statement batch)
- Toolbar: after Refresh Schema button, before hint:

```tsx
<span className="db-badge" title={`Current database: ${database}`}>{database}</span>
<span className="hint">Ctrl+Enter to execute</span>
```

CSS: move `margin-left: auto` from `.hint` to `.db-badge` so badge sits on the right with hint beside it.

```css
.query-editor-toolbar .db-badge {
  margin-left: auto;
  font-size: 12px;
  color: var(--vscode-badge-foreground, #9cdcfe);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  padding: 2px 8px;
}
.query-editor-toolbar .hint {
  margin-left: 0;
  /* ...keep font-size/color */
}
```

Render `<StatementSummaryList>` above `QueryResultsGrid` when `batchStatements` is non-null and length > 0.

For grid data from batch:

```ts
function lastResultSet(statements: StatementResult[]): ResultState | null {
  for (let i = statements.length - 1; i >= 0; i--) {
    const s = statements[i];
    if (s.status === 'ok' && (s.columns?.length ?? 0) > 0) {
      return {
        columns: s.columns ?? [],
        rows: s.rows ?? [],
        affectedRows: s.affectedRows ?? 0,
        executionTime: s.executionTime ?? 0,
      };
    }
  }
  // DDL-only success: show affectedRows from last ok without columns
  const lastOk = [...statements].reverse().find((s) => s.status === 'ok');
  if (lastOk) {
    return {
      columns: [],
      rows: [],
      affectedRows: lastOk.affectedRows ?? 0,
      executionTime: lastOk.executionTime ?? 0,
    };
  }
  const err = statements.find((s) => s.status === 'error');
  if (err) {
    return { columns: [], rows: [], affectedRows: 0, executionTime: 0, error: err.error };
  }
  return null;
}
```

History: when batch completes with any `ok`, add `lastSqlRef.current` once (existing effect can key off derived result without error).

- [ ] **Step 4: Run webview tests + build**

Run:

```bash
cd /Users/linonon/Workspace/tools/SQL-Extension/webview-ui && npm test -- StatementSummaryList && npm run build
cd /Users/linonon/Workspace/tools/SQL-Extension && npm run build
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/query-editor/StatementSummaryList.tsx \
  webview-ui/src/components/query-editor/StatementSummaryList.test.tsx \
  webview-ui/src/components/query-editor/QueryEditor.tsx \
  webview-ui/src/styles/query-editor.css
git commit -m "feat(query): DB badge and compact multi-statement summary list"
```

---

### Task 6: Manual verification checklist (no new code)

**Files:** none (run against rebuilt / reinstalled extension)

- [ ] **Step 1: Rebuild both targets**

```bash
cd /Users/linonon/Workspace/tools/SQL-Extension && npm run build
cd webview-ui && npm run build
```

Sync/repackage into the installed extension if required by `build-install-workflow` memory.

- [ ] **Step 2: Manual cases**

1. Two `ALTER TABLE ...;` on MySQL — both OK in summary; no syntax error at statement 2
2. `SELECT 1; SELECT 2;` — summary 2 OK; grid shows last select
3. `SELECT 1; SELECT bad; SELECT 3;` — ok / error / skipped
4. Toolbar badge shows current database name (read-only)
5. Select only first ALTER in editor — Execute runs one statement
6. Destructive script still shows one confirm modal
7. Cancel mid-run leaves remaining as skipped (best-effort)

- [ ] **Step 3: Final commit only if checklist found fixes**

Otherwise done — no empty commit.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Host-side `;` split shared with destructive net | Task 1 |
| MySQL sequential execute, stop on error, skipped remainder | Task 3 |
| `queryBatchResult` protocol | Task 2–3 |
| Compact summary list (A) | Task 5 |
| Read-only DB badge | Task 5 |
| Selection else full text | Task 4 |
| No `multiStatements` / no full-script transaction | Global + Task 3 |
| Non-MySQL unchanged single path | Task 3 |
| Tests for split + stop-on-error + UI | Tasks 1, 3, 5 |
| Cancel → skipped | Task 3 (+ manual Task 6) |

No TBD placeholders. Types `StatementResult` / `queryBatchResult` consistent across tasks.
