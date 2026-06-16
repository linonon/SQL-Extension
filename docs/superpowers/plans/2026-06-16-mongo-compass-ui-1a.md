# Mongo Compass 化 UI — Phase 1a (多视图只读) 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Mongo 文档浏览器加 List / JSON / Table 三档视图切换, List/JSON 用真嵌套折叠树渲染, 解决"看不清嵌套 + 单一视图"两个痛点; 编辑暂时桥接旧全屏详情。

**Architecture:** 后端新增不拍平的取数路径 (`deepFormatDocument` + `findDocumentsForBrowser`), 让 webview 拿到真嵌套结构 (叶子仍是 shell-tag 字符串, 复用现有正则工具链)。前端把现 `MongoDocumentTable` 改名为 `MongoDocumentPanel`, body 按 `view` 分发到 `MongoTableView` / `MongoDocumentList`(卡片 + `MongoJsonTree`)。

**Tech Stack:** TypeScript, React, Vitest, esbuild (extension host) + Vite (webview-ui)。

**Spec:** [2026-06-16-mongo-compass-ui-design.md](/Users/linonon/Workspace/tools/SQL-Extension/docs/superpowers/specs/2026-06-16-mongo-compass-ui-design.md)

**测试命令约定:**
- Extension host (根目录): `npx vitest run <path>`
- Webview (webview-ui 目录): `cd webview-ui && npx vitest run <path>`
- 构建验证: extension host 改动跑 `npm run build`; webview 改动跑 `cd webview-ui && npm run build` ([build.md](/Users/linonon/Workspace/tools/SQL-Extension/.claude/rules/build.md))

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| [mongo-driver.ts](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts) | `deepFormatValue`/`deepFormatDocument` + `findDocumentsForBrowser` | 改 |
| [mongo-message-handler.ts](/Users/linonon/Workspace/tools/SQL-Extension/src/providers/mongo-message-handler.ts) | `mongoFindDocuments` 重指向深取数 | 改 |
| `webview-ui/src/components/mongo-browser/ViewToggle.tsx` | List/JSON/Table 分段控件 | 建 |
| `webview-ui/src/components/mongo-browser/mongo-leaf-type.ts` | shell-tag 叶子类型识别 | 建 |
| `webview-ui/src/components/mongo-browser/MongoJsonTree.tsx` | 递归可折叠只读树 | 建 |
| `webview-ui/src/components/mongo-browser/MongoDocumentCard.tsx` | 单文档卡片 (view 态 + 悬停操作) | 建 |
| `webview-ui/src/components/mongo-browser/MongoDocumentList.tsx` | List/JSON 卡片容器 | 建 |
| `webview-ui/src/components/mongo-browser/MongoTableView.tsx` | 现有 `<table>` 抽出 + 嵌套单元格修正 | 建 |
| [MongoDocumentTable.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentTable.tsx) | 改名 `MongoDocumentPanel`, 视图分发 | 改 |

---

## Task 1: 后端 deepFormatValue / deepFormatDocument

**Files:**
- Modify: `src/drivers/mongo-driver.ts` (在 `flattenValue` 附近新增, 不动 `flattenValue`)
- Test: `src/drivers/mongo-driver.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `src/drivers/mongo-driver.test.ts` 顶部 import 改为包含被测函数:

```ts
import { MongoDriver, deepFormatValue, deepFormatDocument } from './mongo-driver';
import { ObjectId, Long } from 'mongodb';
```

在文件末尾 `describe('MongoDriver', ...)` 之外追加:

```ts
describe('deepFormatValue', () => {
  it('保留嵌套对象与数组, 叶子转 shell-tag 字符串', () => {
    const out = deepFormatValue({
      _id: new ObjectId('a'.repeat(24)),
      bind: { aid: 'w-1', at: new Date('2020-05-11T02:56:02.131Z'), n: Long.fromString('14') },
      tags: ['x', { k: 1 }],
    }) as Record<string, unknown>;

    expect(out._id).toBe(`ObjectId("${'a'.repeat(24)}")`);
    expect((out.bind as Record<string, unknown>).aid).toBe('w-1');
    expect((out.bind as Record<string, unknown>).at).toBe('ISODate("2020-05-11T02:56:02.131Z")');
    expect((out.bind as Record<string, unknown>).n).toBe('NumberLong("14")');
    expect(Array.isArray(out.tags)).toBe(true);
    expect((out.tags as unknown[])[1]).toEqual({ k: 1 });
  });

  it('null/标量原样', () => {
    expect(deepFormatValue(null)).toBe(null);
    expect(deepFormatValue(42)).toBe(42);
    expect(deepFormatValue('plain')).toBe('plain');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/drivers/mongo-driver.test.ts -t deepFormatValue`
Expected: FAIL — `deepFormatValue is not a function` / import 解析失败

- [ ] **Step 3: 实现** — 在 `src/drivers/mongo-driver.ts` 的 `flattenValue` 定义之后新增 (注意 `export`):

```ts
// deep 格式化: 保留嵌套结构 (object/array 不 JSON.stringify), 叶子 BSON 转 shell-tag 字符串.
// 供文档浏览器渲染折叠树用; flattenValue 仍服务于查询编辑器的扁平表格.
export function deepFormatValue(value: unknown): unknown {
  if (value === null || value === undefined) { return null; }
  if (value instanceof ObjectId) { return `ObjectId("${value.toString()}")`; }
  if (value instanceof Date) { return `ISODate("${value.toISOString()}")`; }
  if (Array.isArray(value)) { return value.map(deepFormatValue); }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('_bsontype' in obj) {
      const bt = (obj as { _bsontype: string })._bsontype;
      if (bt === 'Long') { return `NumberLong("${String(value)}")`; }
      if (bt === 'Int32') { return `NumberInt(${String(value)})`; }
      if (bt === 'Decimal128') { return `NumberDecimal("${String(value)}")`; }
      if (bt === 'MinKey') { return 'MinKey()'; }
      if (bt === 'MaxKey') { return 'MaxKey()'; }
      return String(value);
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) { result[k] = deepFormatValue(v); }
    return result;
  }
  return value;
}

export function deepFormatDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    result[key] = deepFormatValue(value);
  }
  return result;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/drivers/mongo-driver.test.ts -t deepFormatValue`
Expected: PASS (2 个用例)

- [ ] **Step 5: 跑全量 driver 测试确认没破坏 flattenValue**

Run: `npx vitest run src/drivers/mongo-driver.test.ts`
Expected: PASS (含原有 `flattenValue via execute/find` 用例)

- [ ] **Step 6: Commit**

```bash
git add src/drivers/mongo-driver.ts src/drivers/mongo-driver.test.ts
git commit -m "feat(mongo): add deepFormatValue preserving nested structure for browser"
```

---

## Task 2: 后端 findDocumentsForBrowser 驱动方法

**Files:**
- Modify: `src/drivers/mongo-driver.ts` (类内新增方法, 放在 `exportDocuments` 附近)
- Test: `src/drivers/mongo-driver.test.ts`

- [ ] **Step 1: 写失败测试** — 追加 describe:

```ts
describe('findDocumentsForBrowser', () => {
  it('返回深层 rows (嵌套保留) + inferSchema columns', async () => {
    mockDb.command.mockResolvedValue({ ok: 1 });
    await driver.connect({
      id: 't', name: 't', driverType: 'mongodb',
      host: 'localhost', port: 27017, username: '', password: '', database: '',
    });
    mockCollection.aggregate.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        { _id: new ObjectId('b'.repeat(24)), bind: { aid: 'w-1' } },
      ]),
    });

    const res = await driver.findDocumentsForBrowser('db', 'coll', []);

    expect(res.rows[0].bind).toEqual({ aid: 'w-1' });
    expect(res.rows[0]._id).toBe(`ObjectId("${'b'.repeat(24)}")`);
    expect(res.columns.some((c) => c.name === '_id')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/drivers/mongo-driver.test.ts -t findDocumentsForBrowser`
Expected: FAIL — `driver.findDocumentsForBrowser is not a function`

- [ ] **Step 3: 实现** — 在 `MongoDriver` 类内 `exportDocuments` 方法之后新增 (镜像 `exportDocuments` 的 aggregate 调用):

```ts
async findDocumentsForBrowser(
  database: string,
  collection: string,
  pipeline: unknown[]
): Promise<{ rows: Record<string, unknown>[]; columns: ColumnInfo[] }> {
  this.assertConnected();
  const docs = await this.client!.db(database).collection(collection)
    .aggregate(pipeline as Document[]).toArray();
  return { rows: docs.map(deepFormatDocument), columns: inferSchema(docs) };
}
```

若 `Document` 类型未导入, 在文件顶部 `import { ... } from 'mongodb'` 里补 `Document` (与 `ObjectId`/`EJSON` 同处)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/drivers/mongo-driver.test.ts -t findDocumentsForBrowser`
Expected: PASS

- [ ] **Step 5: 类型检查 + 全量 driver 测试**

Run: `npx vitest run src/drivers/mongo-driver.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/drivers/mongo-driver.ts src/drivers/mongo-driver.test.ts
git commit -m "feat(mongo): add findDocumentsForBrowser returning deep nested rows"
```

---

## Task 3: handler mongoFindDocuments 重指向深取数

**Files:**
- Modify: `src/providers/mongo-message-handler.ts:48-76`
- Test: `src/providers/mongo-message-handler.test.ts`

- [ ] **Step 1: 写失败测试** — 追加 describe (自建 driver mock, 同时提供 `findDocumentsForBrowser` 与 `executeCancellable`):

```ts
describe('mongoFindDocuments 深取数', () => {
  it('用 findDocumentsForBrowser 的嵌套 rows 发 mongoDocumentList', async () => {
    const posted: any[] = [];
    const driver: any = {
      findDocumentsForBrowser: vi.fn().mockResolvedValue({
        rows: [{ _id: 'ObjectId("c")', bind: { aid: 'w-1' } }],
        columns: [{ name: '_id', dataType: 'ObjectId', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' }],
      }),
      executeCancellable: vi.fn().mockReturnValue({
        promise: Promise.resolve({ columns: [], rows: [{ count: 1 }], affectedRows: 0, executionTime: 0 }),
        cancel: vi.fn(),
      }),
    };

    await handleMongoMessage(
      { type: 'mongoFindDocuments', database: 'db', collection: 'coll', filter: '', sort: '', projection: '', skip: 0, limit: 50 } as any,
      driver,
      (m) => posted.push(m),
    );

    expect(driver.findDocumentsForBrowser).toHaveBeenCalledWith('db', 'coll', expect.any(Array));
    const list = posted.find((m) => m.type === 'mongoDocumentList');
    expect(list.rows[0].bind).toEqual({ aid: 'w-1' });
    expect(list.total).toBe(1);
  });
});
```

(import: 复用文件已有的 `handleMongoMessage` import; `vi` 已在文件顶部。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/providers/mongo-message-handler.test.ts -t "深取数"`
Expected: FAIL — 仍走旧 `executeCancellable` 取 docs, `findDocumentsForBrowser` 未被调用

- [ ] **Step 3: 实现** — 把 [mongo-message-handler.ts:48-76](/Users/linonon/Workspace/tools/SQL-Extension/src/providers/mongo-message-handler.ts:48) 的 `case 'mongoFindDocuments'` 改为:

```ts
    case 'mongoFindDocuments': {
      const { database, collection, filter, sort, projection, skip, limit } = message;
      try {
        const pipeline = buildAggregatePipeline(filter, sort, projection, skip, limit);
        const countFilter = filter.trim() ? convertShellToJson(filter.trim()) : '{}';
        const countQuery = `db.${collection}.countDocuments(${countFilter})`;

        const mongo = driver as unknown as MongoDriver;
        const [docsResult, countResult] = await Promise.all([
          mongo.findDocumentsForBrowser(database, collection, pipeline),
          driver.executeCancellable(countQuery, undefined, database).promise,
        ]);

        const total = countResult.rows.length > 0
          ? Number((countResult.rows[0] as Record<string, unknown>).count ?? 0)
          : 0;

        post({
          type: 'mongoDocumentList',
          columns: docsResult.columns,
          rows: docsResult.rows,
          total,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoDocumentList', columns: [], rows: [], total: 0, error: errorMsg });
      }
      return true;
    }
```

- [ ] **Step 4: 跑测试确认通过 + 全量 handler 测试**

Run: `npx vitest run src/providers/mongo-message-handler.test.ts`
Expected: PASS (新用例 + 原有用例)

- [ ] **Step 5: 构建 extension host**

Run: `npm run build`
Expected: 构建成功, 无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/providers/mongo-message-handler.ts src/providers/mongo-message-handler.test.ts
git commit -m "feat(mongo): repoint mongoFindDocuments to deep nested fetch"
```

---

## Task 4: ViewToggle 组件

**Files:**
- Create: `webview-ui/src/components/mongo-browser/ViewToggle.tsx`
- Test: `webview-ui/src/components/mongo-browser/ViewToggle.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ViewToggle } from './ViewToggle';

describe('ViewToggle', () => {
  it('点 JSON 触发 onChange(json)', () => {
    const onChange = vi.fn();
    render(<ViewToggle value="list" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /json/i }));
    expect(onChange).toHaveBeenCalledWith('json');
  });

  it('当前视图按钮标记 aria-pressed', () => {
    render(<ViewToggle value="table" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /table/i })).toHaveAttribute('aria-pressed', 'true');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/ViewToggle.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```tsx
export type MongoView = 'list' | 'json' | 'table';

interface ViewToggleProps {
  readonly value: MongoView;
  readonly onChange: (v: MongoView) => void;
}

const OPTIONS: ReadonlyArray<{ key: MongoView; label: string }> = [
  { key: 'list', label: 'List' },
  { key: 'json', label: 'JSON' },
  { key: 'table', label: 'Table' },
];

export function ViewToggle({ value, onChange }: ViewToggleProps) {
  return (
    <div className="mongo-view-toggle" role="group" aria-label="View mode">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`mongo-view-toggle-btn${value === o.key ? ' active' : ''}`}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/ViewToggle.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/mongo-browser/ViewToggle.tsx webview-ui/src/components/mongo-browser/ViewToggle.test.tsx
git commit -m "feat(mongo): add ViewToggle component"
```

---

## Task 5: mongo-leaf-type 叶子类型识别

**Files:**
- Create: `webview-ui/src/components/mongo-browser/mongo-leaf-type.ts`
- Test: `webview-ui/src/components/mongo-browser/mongo-leaf-type.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { detectLeafType } from './mongo-leaf-type';

describe('detectLeafType', () => {
  it('识别 shell-tag 字符串', () => {
    expect(detectLeafType('ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")')).toBe('ObjectId');
    expect(detectLeafType('ISODate("2020-05-11T02:56:02.131Z")')).toBe('Date');
    expect(detectLeafType('NumberLong("14")')).toBe('Long');
    expect(detectLeafType('NumberDecimal("1.5")')).toBe('Decimal128');
  });

  it('普通字符串/数字/布尔/null 归类', () => {
    expect(detectLeafType('hello')).toBe('string');
    expect(detectLeafType(42)).toBe('number');
    expect(detectLeafType(true)).toBe('boolean');
    expect(detectLeafType(null)).toBe('null');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/mongo-leaf-type.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/mongo-leaf-type.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/mongo-browser/mongo-leaf-type.ts webview-ui/src/components/mongo-browser/mongo-leaf-type.test.ts
git commit -m "feat(mongo): add leaf type detection for json tree"
```

---

## Task 6: MongoJsonTree 递归折叠树

**Files:**
- Create: `webview-ui/src/components/mongo-browser/MongoJsonTree.tsx`
- Test: `webview-ui/src/components/mongo-browser/MongoJsonTree.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MongoJsonTree } from './MongoJsonTree';

describe('MongoJsonTree', () => {
  it('渲染顶层标量字段', () => {
    render(<MongoJsonTree value={{ aid: 'w-1', n: 14 }} />);
    expect(screen.getByText('aid')).toBeInTheDocument();
    expect(screen.getByText('"w-1"')).toBeInTheDocument();
  });

  it('嵌套对象默认折叠, 点击展开', () => {
    render(<MongoJsonTree value={{ bind: { aid: 'w-1' } }} />);
    expect(screen.queryByText('aid')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('bind'));
    expect(screen.getByText('aid')).toBeInTheDocument();
  });

  it('shell-tag 叶子带类型 badge', () => {
    render(<MongoJsonTree value={{ _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")' }} />);
    expect(screen.getByText('ObjectId')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/MongoJsonTree.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现** — 所有容器节点默认折叠 (字段名行始终可见, 点击展开嵌套内容, Compass 式); 长字符串截断可点开:

```tsx
import { useState } from 'react';
import { detectLeafType, type LeafType } from './mongo-leaf-type';

interface TreeNodeProps {
  readonly name: string;
  readonly value: unknown;
  readonly depth: number;
}

const LEAF_CLASS: Record<LeafType, string> = {
  ObjectId: 'leaf-id', Date: 'leaf-date', Long: 'leaf-num', Int: 'leaf-num',
  Decimal128: 'leaf-num', MinKey: 'leaf-key', MaxKey: 'leaf-key',
  string: 'leaf-str', number: 'leaf-num', boolean: 'leaf-bool', null: 'leaf-null',
};

const MAX_STR = 200;

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object';
}

function Leaf({ value }: { readonly value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const type = detectLeafType(value);
  const raw = value === null ? 'null' : typeof value === 'string' ? value : String(value);
  const display = type === 'string' ? `"${raw}"` : raw;
  const long = display.length > MAX_STR;
  const shown = long && !expanded ? display.slice(0, MAX_STR) + '…' : display;
  return (
    <span className={`mongo-tree-leaf ${LEAF_CLASS[type]}`}>
      {shown}
      {long && (
        <button className="mongo-tree-more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'less' : 'more'}
        </button>
      )}
      {(type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'null') && (
        <span className="mongo-tree-badge">{type}</span>
      )}
    </span>
  );
}

function TreeNode({ name, value, depth }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);

  if (!isContainer(value)) {
    return (
      <div className="mongo-tree-row" style={{ paddingLeft: depth * 16 }}>
        <span className="mongo-tree-key">{name}</span>: <Leaf value={value} />
      </div>
    );
  }

  const entries: ReadonlyArray<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  const summary = Array.isArray(value) ? `[ ${entries.length} items ]` : `{ ${entries.length} fields }`;

  return (
    <div>
      <div
        className="mongo-tree-row mongo-tree-toggle"
        style={{ paddingLeft: depth * 16 }}
        onClick={() => setExpanded((e) => !e)}
      >
        <i className={`ti ti-chevron-${expanded ? 'down' : 'right'} mongo-tree-chevron`} aria-hidden="true" />
        <span className="mongo-tree-key">{name}</span>
        {!expanded && <span className="mongo-tree-summary"> {summary}</span>}
      </div>
      {expanded && entries.map(([k, v]) => (
        <TreeNode key={k} name={k} value={v} depth={depth + 1} />
      ))}
    </div>
  );
}

export function MongoJsonTree({ value }: { readonly value: Record<string, unknown> }) {
  return (
    <div className="mongo-json-tree">
      {Object.entries(value).map(([k, v]) => (
        <TreeNode key={k} name={k} value={v} depth={0} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/MongoJsonTree.test.tsx`
Expected: PASS (3 个用例)

- [ ] **Step 5: 加样式** — 在 [mongo-browser.css](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/styles/mongo-browser.css) 末尾追加 (用 VS Code 主题变量, 与现有样式一致):

```css
.mongo-json-tree { font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; line-height: 1.7; }
.mongo-tree-row { white-space: pre-wrap; word-break: break-word; }
.mongo-tree-toggle { cursor: pointer; user-select: none; }
.mongo-tree-chevron { font-size: 13px; vertical-align: -2px; opacity: 0.7; margin-right: 2px; }
.mongo-tree-key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
.mongo-tree-summary { color: var(--vscode-descriptionForeground); opacity: 0.7; }
.mongo-tree-leaf.leaf-str { color: var(--vscode-debugTokenExpression-string, #ce9178); }
.mongo-tree-leaf.leaf-num { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.mongo-tree-leaf.leaf-bool { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
.mongo-tree-leaf.leaf-null { color: var(--vscode-descriptionForeground); }
.mongo-tree-leaf.leaf-id, .mongo-tree-leaf.leaf-date, .mongo-tree-leaf.leaf-key { color: var(--vscode-debugTokenExpression-name, #4ec9b0); }
.mongo-tree-badge { margin-left: 6px; font-size: 10px; padding: 0 4px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.mongo-tree-more { margin-left: 6px; font-size: 10px; background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; }
```

- [ ] **Step 6: Commit**

```bash
git add webview-ui/src/components/mongo-browser/MongoJsonTree.tsx webview-ui/src/components/mongo-browser/MongoJsonTree.test.tsx webview-ui/src/styles/mongo-browser.css
git commit -m "feat(mongo): add collapsible MongoJsonTree renderer"
```

---

## Task 7: MongoDocumentCard (view 态 + 悬停操作)

**Files:**
- Create: `webview-ui/src/components/mongo-browser/MongoDocumentCard.tsx`
- Test: `webview-ui/src/components/mongo-browser/MongoDocumentCard.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoDocumentCard } from './MongoDocumentCard';

const doc = { _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', aid: 'w-1' };

describe('MongoDocumentCard', () => {
  it('list 视图渲染树, 含字段名', () => {
    render(<MongoDocumentCard doc={doc} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('aid')).toBeInTheDocument();
  });

  it('json 视图渲染 shell 文本', () => {
    render(<MongoDocumentCard doc={doc} view="json" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/ObjectId\("a+"\)/)).toBeInTheDocument();
  });

  it('点 Edit 回调带文档', () => {
    const onEdit = vi.fn();
    render(<MongoDocumentCard doc={doc} view="list" onEdit={onEdit} onClone={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(doc);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/MongoDocumentCard.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现** — JSON 视图复用 `jsonToShell`; Copy 用 `navigator.clipboard`:

```tsx
import { MongoJsonTree } from './MongoJsonTree';
import { jsonToShell } from '../../utils/mongo-shell-to-json';
import type { MongoView } from './ViewToggle';

interface MongoDocumentCardProps {
  readonly doc: Record<string, unknown>;
  readonly view: Exclude<MongoView, 'table'>;
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
}

export function MongoDocumentCard({ doc, view, onEdit, onClone, onDelete }: MongoDocumentCardProps) {
  const id = String(doc._id ?? '');
  const shellText = jsonToShell(JSON.stringify(doc, null, 2));

  return (
    <div className="mongo-doc-card">
      <div className="mongo-doc-card-actions">
        <button className="btn-small" aria-label="Edit" title="Edit" onClick={() => onEdit(doc)}><i className="ti ti-edit" /></button>
        <button className="btn-small" aria-label="Copy" title="Copy" onClick={() => navigator.clipboard.writeText(shellText)}><i className="ti ti-copy" /></button>
        <button className="btn-small" aria-label="Clone" title="Clone (new _id)" onClick={() => onClone(doc)}><i className="ti ti-copy-plus" /></button>
        <button className="btn-small btn-danger" aria-label="Delete" title="Delete" onClick={() => onDelete(id)}><i className="ti ti-trash" /></button>
      </div>
      {view === 'list'
        ? <MongoJsonTree value={doc} />
        : <pre className="mongo-doc-card-json">{shellText}</pre>}
    </div>
  );
}
```

样式追加到 [mongo-browser.css](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/styles/mongo-browser.css):

```css
.mongo-doc-card { position: relative; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
.mongo-doc-card-actions { position: absolute; top: 6px; right: 8px; display: flex; gap: 4px; opacity: 0; transition: opacity .12s; }
.mongo-doc-card:hover .mongo-doc-card-actions { opacity: 1; }
.mongo-doc-card-json { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; line-height: 1.6; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/MongoDocumentCard.test.tsx`
Expected: PASS (3 个用例)

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/mongo-browser/MongoDocumentCard.tsx webview-ui/src/components/mongo-browser/MongoDocumentCard.test.tsx webview-ui/src/styles/mongo-browser.css
git commit -m "feat(mongo): add MongoDocumentCard view-mode with hover actions"
```

---

## Task 8: MongoDocumentList 容器

**Files:**
- Create: `webview-ui/src/components/mongo-browser/MongoDocumentList.tsx`
- Test: `webview-ui/src/components/mongo-browser/MongoDocumentList.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoDocumentList } from './MongoDocumentList';

const rows = [
  { _id: 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")', aid: 'w-1' },
  { _id: 1102025811, aid: 'w-2' },
];

describe('MongoDocumentList', () => {
  it('渲染每个文档一张卡片', () => {
    render(<MongoDocumentList rows={rows} view="list" onEdit={vi.fn()} onClone={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getAllByText('aid')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/MongoDocumentList.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```tsx
import { MongoDocumentCard } from './MongoDocumentCard';
import type { MongoView } from './ViewToggle';

interface MongoDocumentListProps {
  readonly rows: readonly Record<string, unknown>[];
  readonly view: Exclude<MongoView, 'table'>;
  readonly onEdit: (doc: Record<string, unknown>) => void;
  readonly onClone: (doc: Record<string, unknown>) => void;
  readonly onDelete: (id: string) => void;
}

export function MongoDocumentList({ rows, view, onEdit, onClone, onDelete }: MongoDocumentListProps) {
  return (
    <div className="mongo-doc-list">
      {rows.map((row, idx) => (
        <MongoDocumentCard
          key={String(row._id ?? idx)}
          doc={row}
          view={view}
          onEdit={onEdit}
          onClone={onClone}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/MongoDocumentList.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/mongo-browser/MongoDocumentList.tsx webview-ui/src/components/mongo-browser/MongoDocumentList.test.tsx
git commit -m "feat(mongo): add MongoDocumentList container"
```

---

## Task 9: MongoTableView 抽出 + 嵌套单元格修正

**Files:**
- Create: `webview-ui/src/components/mongo-browser/MongoTableView.tsx`
- Test: `webview-ui/src/components/mongo-browser/MongoTableView.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoTableView } from './MongoTableView';

const columns = [
  { name: '_id', dataType: 'ObjectId', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
  { name: 'bind', dataType: 'object', nullable: true, defaultValue: null, isPrimaryKey: false, extra: '' },
];
const rows = [{ _id: 'ObjectId("a")', bind: { aid: 'w-1' } }];

describe('MongoTableView', () => {
  it('嵌套对象单元格显示 JSON 预览而非 [object Object]', () => {
    render(<MongoTableView columns={columns} rows={rows} onRowClick={vi.fn()} />);
    expect(screen.getByText(/"aid":"w-1"/)).toBeInTheDocument();
  });

  it('点行回调带该行', () => {
    const onRowClick = vi.fn();
    render(<MongoTableView columns={columns} rows={rows} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText(/"aid":"w-1"/).closest('tr')!);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/MongoTableView.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现** — 把 [MongoDocumentTable.tsx:278-303](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentTable.tsx:278) 的 `<table>` 抽出, `truncate` 加 object 分支:

```tsx
import type { ColumnInfo } from '../../types/database';

interface MongoTableViewProps {
  readonly columns: readonly ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  readonly onRowClick: (row: Record<string, unknown>) => void;
}

function cellText(value: unknown, max: number): string {
  if (value === null || value === undefined) { return '(null)'; }
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

export function MongoTableView({ columns, rows, onRowClick }: MongoTableViewProps) {
  return (
    <table className="mongo-table">
      <thead>
        <tr>{columns.map((col) => <th key={col.name} title={col.dataType}>{col.name}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => (
          <tr key={String(row._id ?? idx)} className="mongo-document-row" onClick={() => onRowClick(row)}>
            {columns.map((col) => {
              const v = row[col.name];
              const full = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
              return <td key={col.name} title={full}>{cellText(v, 80)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/MongoTableView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/mongo-browser/MongoTableView.tsx webview-ui/src/components/mongo-browser/MongoTableView.test.tsx
git commit -m "feat(mongo): extract MongoTableView with nested cell preview"
```

---

## Task 10: 接入 MongoDocumentPanel (视图分发)

**Files:**
- Modify: [MongoDocumentTable.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentTable.tsx) (改名语义为 panel, 文件名暂留以减小 diff; 内部接 ViewToggle + 视图分发)
- Test: 现有 `MongoDocumentDetail.test.tsx` 不动; 本任务靠手动验证 + 既有测试回归

- [ ] **Step 1: 加视图 state + ViewToggle** — 在 `MongoDocumentTable` 组件内顶部加:

```tsx
import { ViewToggle, type MongoView } from './ViewToggle';
import { MongoDocumentList } from './MongoDocumentList';
import { MongoTableView } from './MongoTableView';
// ...
const [view, setView] = useState<MongoView>('list');
```

在 header 的 `<div className="mongo-header-row">` 里, `+ New Document` 按钮旁加:

```tsx
<ViewToggle value={view} onChange={setView} />
```

- [ ] **Step 2: body 按 view 分发** — 把 [MongoDocumentTable.tsx:278-303](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentTable.tsx:278) 的整段 `<table>...</table>` 替换为:

```tsx
{!loading && !queryError && rows.length > 0 && (
  view === 'table'
    ? <MongoTableView columns={columns} rows={rows} onRowClick={(row) => setDetail({ mode: 'edit', doc: row })} />
    : <MongoDocumentList
        rows={rows}
        view={view}
        onEdit={(doc) => setDetail({ mode: 'edit', doc })}
        onClone={(doc) => setDetail({ mode: 'edit', doc })}
        onDelete={(id) => onDeleteDocument(id)}
      />
)}
```

注: 本期 `onClone` 暂等同 Edit (桥接旧详情), 真 Clone 在 1c 接; `onDelete` 直连现有 `onDeleteDocument` prop (删除确认仍由 extension host 拦截, 见 [conventions.md](/Users/linonon/Workspace/tools/SQL-Extension/.claude/rules/conventions.md))。

- [ ] **Step 3: 回归既有 webview 测试**

Run: `cd webview-ui && npx vitest run src/components/mongo-browser/`
Expected: PASS (全部 mongo-browser 测试)

- [ ] **Step 4: 构建 webview**

Run: `cd webview-ui && npm run build`
Expected: 构建成功

- [ ] **Step 5: 手动验证** — 按 [build-install-workflow](/Users/linonon/.claude/projects/-Users-linonon-Workspace-tools-SQL-Extension/memory/build-install-workflow.md) 装好后, 连 Mongo, 确认:
  - 默认 List 视图, 每文档一张卡片, 嵌套对象可折叠展开
  - 切 JSON 视图显示 shell 文本; 切 Table 视图回到表格 (嵌套字段显示 JSON 预览, 非 `[object Object]`)
  - 卡片悬停浮出 Edit/Copy/Clone/Delete; 点 Edit 进旧全屏详情可正常保存; Delete 弹确认
  - 找一个真嵌套 collection 验证树渲染 (非 user_stats 这种扁平的)

- [ ] **Step 6: Commit**

```bash
git add webview-ui/src/components/mongo-browser/MongoDocumentTable.tsx
git commit -m "feat(mongo): wire view toggle dispatching list/json/table"
```

---

## Phase 1a 完成定义

- List/JSON/Table 三视图可切, 默认 List
- 嵌套文档在 List 树 / JSON 文本 / Table 预览里都能看清, 不再是字符串或 `[object Object]`
- 卡片 Edit 桥接旧详情, 编辑/删除链路不破
- 全量测试通过, 两端构建通过

## 后续计划 (各自单独成文, 1a 落地后再详写)

- **1b in-card 编辑**: 抽 `MongoDocumentEditor` (复用 HighlightEditor + 补全 + Ctrl+F + Copy as + dirty), 卡片内原地编辑替换桥接, 移除全屏 `MongoDocumentDetail`, 未保存拦截下移卡片级。
- **1c Clone**: `onClone` 改为 seed 一张可编辑 `_id` 的新建卡片, 走 insert; 前置验证后端 `mongoInsertDocument` 对 `_id` 类型的保留 (见 spec 待验证项)。
- **2 查询优化**: filter builder / 查询历史。
