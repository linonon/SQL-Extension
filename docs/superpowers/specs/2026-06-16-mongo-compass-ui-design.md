# Mongo 浏览器 Compass 化 UI/UX 改造设计

## 背景与目标

当前 Mongo 浏览器右面板的交互是"表格行 -> 全屏详情"二选一: 点一行就把整个表格替换成编辑器, 丢失列表上下文; 嵌套文档被压成扁平表格, 每字段截断 80 字符, 看不清结构; 只有 table 一种展示; 且无法换 `_id`.

目标: 模仿 MongoDB Compass 的文档列表模型 -- 列表本身即编辑器, 每个文档是一张可折叠的卡片, view / edit / clone / delete 全在卡片内完成, 列表常驻. 提供 List / JSON / Table 三档视图切换.

一招收敛四个痛点:

- 看文档切走整个表格 -> in-card 编辑, 列表不动
- 扁平表格看不清嵌套 -> 可折叠 JSON 树 + JSON 视图
- 想换 `_id` -> Clone 工作流 (复制成新建卡片, `_id` 可编辑, 走 insert)
- 多种展示风格 -> List / JSON / Table 视图切换

查询输入门槛 (filter builder / 历史) 作为独立第二期, 本文档只提及不展开.

## 现状

右面板入口 [MongoBrowser.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoBrowser.tsx) 持有全部状态 (collections / selected / rows / columns / filter / sort / projection / page) 与所有 postMessage 处理 (insert / update / delete / export / import), 透传给下层.

[MongoDocumentTable.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentTable.tsx) 名为 Table, 实为整个右面板容器: header (collection 名 + New Document + filter 控件) + body (表格 or 全屏详情) + 分页. 点行 -> 切到 [MongoDocumentDetail.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx) 全屏 (整体 return 替换).

[MongoDocumentDetail.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx) 是全屏编辑器, 集成了不少能力, 重构必须复用不能丢:

- shell 语法 + 字段自动补全 ([useMongoAutocomplete](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/hooks/useMongoAutocomplete.ts))
- Ctrl+F 文档内搜索 (prev / next / 计数)
- Copy as Shell / EJSON / JSON
- dirty 追踪 + 未保存改动拦截对话框 (切 collection / 切文档时)
- 编辑时 `stripId` 剥掉 `_id` ([MongoDocumentDetail.tsx:21](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx:21)), `_id` 只读显示

后端保存路径 [mongo-message-handler.ts:91](/Users/linonon/Workspace/tools/SQL-Extension/src/providers/mongo-message-handler.ts:91):

- update: `db.coll.updateOne({"_id": id}, {"$set": document})`, `document` 不含 `_id`
- delete: `db.coll.deleteOne({"_id": id})`
- 驱动仅对 24-hex ObjectId 把字符串强转为 ObjectId ([mongo-driver.ts:302](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts:302))

`rows` 已是解析好的对象数组: 嵌套对象 / 数组是真实 JS 对象, 日期等类型由后端预序列化成 shell 字符串形式 (如 `ISODate("...")` / `ObjectId("...")`). 视图渲染据此处理.

## 目标组件结构

```
MongoDocumentPanel (现 MongoDocumentTable 改名)
├─ header: collection 名 + New Document + ViewToggle(List/JSON/Table)
├─ filter controls (不动)
├─ body 按 view 分发:
│   ├─ 'list'  -> MongoDocumentList -> 每文档一张 MongoDocumentCard (可折叠树)
│   ├─ 'json'  -> 同上, 卡片 body 换成 pretty shell 文本 (只读高亮)
│   └─ 'table' -> MongoTableView (现有 <table> 抽出, 逻辑不动)
└─ pagination (不动)
```

新增文件 (遵循 high cohesion / many small files):

- `MongoDocumentList.tsx` -- 卡片容器, 按 view 分发渲染, 维护"当前编辑态卡片"
- `MongoDocumentCard.tsx` -- 单文档卡片, 三态 view / edit / clone; view 态渲染树 + 悬停浮出 Edit / Copy / Clone / Delete
- `MongoJsonTree.tsx` -- 递归可折叠只读树, 类型 badge (ObjectId / ISODate / Int64 等), 长字符串截断可展开
- `MongoDocumentEditor.tsx` -- 从 [MongoDocumentDetail.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx) 抽出的可复用编辑器内核 (HighlightEditor + 补全 + Ctrl+F + Copy as + dirty 追踪 + shell<->json parse)
- `MongoTableView.tsx` -- 现 [MongoDocumentTable.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentTable.tsx) 里的 `<table>` 部分原样抽出
- `ViewToggle.tsx` -- List / JSON / Table 分段控件 (体量小, 也可内联进 header)

## 状态管理

视图与编辑态归 MongoDocumentPanel / MongoDocumentList 层 (右面板内), 不上提到 MongoBrowser:

- `view: 'list' | 'json' | 'table'` -- 默认 `'list'`, 在 session 内跨 collection 保持 (切 collection 不重置视图偏好)
- `editingId: string | null` -- 正在 in-card 编辑的现存文档 `_id`
- `composing: null | { mode: 'insert'; seed?: Record<string, unknown> }` -- New Document (无 seed) 或 Clone (seed = 源文档含 `_id`), 渲染为列表顶部一张新建卡片
- 同一时刻只允许一个活动编辑器 (`editingId` 与 `composing` 互斥)
- dirty 追踪只针对当前活动编辑器

## 数据流

- 视图切换纯前端: 同一份 `rows` 换渲染方式, 零新增 round-trip
- 编辑保存: `onUpdateDocument(id, doc)` -> 现有 `mongoUpdateDocument` (`_id` 仍 strip)
- 新建保存: `onInsertDocument(doc)` -> 现有 `mongoInsertDocument`
- Clone 保存: 走 insert 路径, `doc` 含用户改过的 `_id` (insert 天然保留 `_id` 及其类型)
- 删除: `onDeleteDocument(id)` -> 现有 `mongoDeleteDocument`

后端在 1a / 1b 零改动; 1c 需验证 insert 路径对 `_id` 的透传与类型保留 (见待验证项).

## 分期计划

### 1a 读 (多视图) -- 解决"看不清嵌套 + 多视图"

- 加 ViewToggle (List / JSON / Table), 默认 List
- MongoTableView: 把现有 `<table>` 原样抽出, 行为不变
- MongoDocumentList + MongoDocumentCard (view 态) + MongoJsonTree: List 视图渲染可折叠树, JSON 视图渲染 pretty shell 文本 (只读高亮)
- 卡片悬停操作行: 本期只接 Copy 与 Delete (复用现有 delete 链路); Edit 临时打开旧的全屏 [MongoDocumentDetail.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx) 作桥, 不破坏编辑能力; Clone 按钮先禁用/隐藏
- 测试: JsonTree (嵌套 / 折叠展开 / 类型 badge / 长串截断), ViewToggle 切换, Card view 态渲染

### 1b in-card 编辑 -- 解决"切走整个表格"

- 把 [MongoDocumentDetail.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx) 编辑器内核抽成 MongoDocumentEditor (含补全 / Ctrl+F / Copy as / dirty / parse)
- MongoDocumentCard edit 态内嵌 MongoDocumentEditor, Update / Cancel 在卡片内, 列表不动
- 未保存切换拦截 (切 collection / 切行 / 切视图带 dirty) 逻辑下移到卡片级, 复用现有对话框
- 移除全屏 MongoDocumentDetail (其能力已并入共享编辑器)
- 测试: edit -> save 调 `onUpdateDocument` 且 doc 已 strip `_id`; dirty 追踪; Cancel 还原; 未保存拦截

### 1c Clone -- 解决"换 `_id`"

- Clone 操作: 源文档 (含 `_id`) 作为 seed 塞进 composing insert 卡片, `_id` 可编辑
- 保存走 insert; 提示用户"若意在重命名 `_id`, 记得删除原文档"
- 验证后端 insert 对 `_id` 的透传与类型保留 (数字型 vs ObjectId)
- 测试: clone 用全文档 (含 `_id`) 作 seed; `_id` 可编辑; save 走 insert 路径

### 2 查询优化 (独立第二期, 本文档不展开)

filter builder / 查询历史 / 常用条件一键填充. 另开 spec.

## 边界与风险

- **`_id` 类型保留 (现存隐患)**: update 把 id 当字符串插值, 驱动只对 24-hex ObjectId 强转 ([mongo-driver.ts:302](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts:302)). 数字型 `_id` (如 Int64 `1102025811`) 走 update 时 filter 可能为字符串而匹配不上. 重构不得让其更糟; 1c 的 clone 走 insert 反而能正确保留类型. 列为待验证项, 不在本次扩大修复范围.
- **深嵌套 / 超大文档**: 顶层默认展开, 更深层默认折叠; 长字符串截断, 点击展开.
- **数组 vs 对象**: 树需区分渲染 (数组显示索引, 对象显示键).
- **单一活动编辑器**: 同时只允许一张卡片处于编辑/新建态.
- **空集合 / 查询错误 / loading**: 复用现有空态与错误态.

## 测试策略

全程 TDD, 沿用现有 Vitest + `.test.tsx` 模式 (参考 [MongoDocumentDetail.test.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.test.tsx) / [extractRawId.test.ts](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/extractRawId.test.ts)). 每期先写测试再实现. 改动 webview 源码后按 [build.md](/Users/linonon/Workspace/tools/SQL-Extension/.claude/rules/build.md) 规则 `cd webview-ui && npm run build` 重新构建验证.

## 待验证项

- 后端 `mongoInsertDocument` 是否透传 `_id` 并保留其 BSON 类型 (1c 前置验证)
- `rows` 中各 BSON 类型的实际线格式 (日期 / Decimal128 / 数组内对象), 决定 MongoJsonTree 的类型 badge 与递归策略 (1a 前置确认)
