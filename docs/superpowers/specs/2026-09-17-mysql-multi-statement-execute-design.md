# MySQL multi-statement Execute + current DB badge

Date: 2026-09-17
Repo: SQL-Extension (`https://github.com/linonon/SQL-Extension.git`)
Status: design approved in brainstorm; awaiting implementation plan

## Problem

1. QueryEditor Execute sends the whole SQL string to `MySQLDriver.executeCancellable` then `conn.query(sql)` with **no** `multiStatements`. mysql2 allows one statement per call, so a script with two `ALTER TABLE ...;` fails at the second statement (`near 'ALTER TABLE ...'`).
2. The editor has a bound `database` (panel context + `USE` before run) but the toolbar does not show it, so the user cannot see which DB Execute will use.

## Goals

- MySQL QueryEditor can run multi-statement scripts sequentially.
- Results area shows a **compact per-statement summary list**.
- On failure: **stop** (no further statements); keep successes; mark remainder skipped.
- Toolbar shows a **read-only** current-database badge.
- If the editor has a **selection**, Execute runs only the selection; otherwise the full text.

## Non-goals (this change)

- PostgreSQL (or other drivers) multi-statement Execute
- Wrapping the whole script in a transaction
- Database switcher / changing connection from the badge
- Multi-result tabs or expandable statement detail UI
- Enabling mysql2 `multiStatements`
- Changing Import / CRUD / MCP execute paths

## Approach

**Host-side split + sequential execute on one connection** (not `multiStatements`, not webview fan-out of N `executeQuery` messages).

Aligns with:

- Existing import path that already runs statements one-by-one via `executeCancellable`
- Existing `isWholeTableWrite` which already strips comments/strings and splits on `;`

## Architecture

### Components

| Unit | Role |
|------|------|
| `webview-ui/.../QueryEditor.tsx` | Resolve SQL text (selection else full); show DB badge; render batch summary |
| `webview-ui/.../SqlEditor` (or selection API) | Expose current selection for Execute |
| `sql-message-handler.ts` `executeQuery` | Confirm destructive ops; split; sequential run; post batch result |
| `src/utils/destructive-sql.ts` (or sibling) | Shared `splitSqlStatements` used by confirm net + execute |
| `MySQLDriver.executeCancellable` | Unchanged contract for a **single** statement; caller loops |

### Data flow

```
QueryEditor.Execute
  -> sql = selection || fullText
  -> postMessage({ type: 'executeQuery', database, sql })
  -> handleSqlMessage
       1. isWholeTableWrite(sql)? modal confirm (existing)
       2. stmts = splitSqlStatements(sql)  // strip comments/strings, split ';', drop empty
       3. conn: USE `database` once (if provided)
       4. for each stmt on same connection:
            ok -> record { status: 'ok', ... }
            err -> record { status: 'error', error }; mark rest 'skipped'; break
            cancel -> mark current/rest skipped; break
       5. post { type: 'queryBatchResult', statements: [...] }
  -> QueryEditor renders compact summary list + badge
```

Single-statement scripts also use `queryBatchResult` with one item (one UI path).

### Protocol: `queryBatchResult`

```ts
type StatementStatus = 'ok' | 'error' | 'skipped';

interface StatementResult {
  index: number;          // 1-based display index
  sql: string;            // statement text as executed
  status: StatementStatus;
  executionTime?: number; // ms, when run
  affectedRows?: number;
  columns?: ColumnInfo[]; // present when result set
  rows?: Record<string, unknown>[];
  error?: string;         // sanitized message when status === 'error'
}

// Extension -> webview
{ type: 'queryBatchResult'; statements: StatementResult[] }
```

Keep existing `queryResult` for any non-Execute callers if still needed; QueryEditor Execute switches to batch only.

### SQL splitting

Extract `splitSqlStatements(sql: string): string[]`:

1. Reuse the same strip-comments-and-strings logic as `isWholeTableWrite`
2. Split on `;`
3. Trim; drop empty segments

**Known limitation (document in UI/docs, do not pretend to parse):** routine bodies / triggers with internal `;` may split incorrectly. Same heuristic class as the existing destructive-confirm net.

### Selection behavior

- If the SQL editor has a non-empty selection, Execute uses that text only.
- Otherwise Execute uses the full editor buffer.
- Badge always reflects the panel-bound `database`, not inferred from SQL.

### Current DB badge

- Read-only chip on the QueryEditor toolbar (right side), label = current `database` prop (e.g. `AGENT_NEW`).
- No click action, no connection name in this change.

### Compact summary list (layout A)

Default (no expand UI in this change):

- One row per statement: `N OK|ERR|skipped · {time} · affected {n}` + truncated SQL
- Error rows use error styling; short error snippet on the row if space allows (full text in `error` field; may show one line under the row without a full expand panel)
- Skipped rows muted
- If exactly one statement and it has a result set, also show the existing results grid below the single summary row (so SELECT UX does not regress). If multiple statements include result sets, show the **last successful result set** in the grid below the list (YAGNI: no per-row expand in this cut). DDL-only batches: list only.

### Cancel

- Cancel targets the in-flight statement (`KILL QUERY` as today).
- Remaining statements -> `skipped`.
- Always reply with `queryBatchResult` (possibly partial), never a silent hang.

### Destructive confirm

Unchanged semantics: if any statement in the script is whole-table destructive, one modal before any execution. Cancel -> empty `queryBatchResult` `{ statements: [] }` for the Execute path after this change.

## Testing

- Unit: `splitSqlStatements` — semicolon inside quotes/comments not split; empty segments dropped
- Unit/integration: sequential runner — two ALTERs both ok; second fails -> first ok, third skipped
- Unit: single statement -> batch length 1
- Unit: `isWholeTableWrite` still statement-aware after shared split helper
- Webview: badge renders `database`; list renders ok/error/skipped states

## Build / commit conventions (project)

- Host changes: root `npm run build`
- Webview changes: `cd webview-ui && npm run build`
- Running extension may load from installed `~/.vscode` copy — rebuild alone may not update live UI until sync/repackage
- Commit: Angular `feat(query): ...` / `fix(query): ...` / `docs(query): ...`; Chinese or English subject OK

## Implementation notes

- Do **not** set `multiStatements: true` on the MySQL pool.
- Do **not** run the batch inside `driver.transaction` (DDL implicit commit; user chose stop-on-error).
- Prefer small shared util over duplicating strip/split.
- Follow existing sanitize-error path for messages shown in the list.
