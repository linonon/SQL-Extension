# Mongo 部分优化设计 (业界调研 + 落地方案)

> 本文是对 [2026-06-16-mongo-compass-ui-design.md](/Users/linonon/Workspace/tools/SQL-Extension/docs/superpowers/specs/2026-06-16-mongo-compass-ui-design.md) 的延伸: 用业界优秀 MongoDB GUI 的设计模式去**验证 / 充实**已有分期, 并补出 spec 还没覆盖的 gap. 聚焦两条主线 -- [展示] 与 [CRUD].

## 研究方法与置信度

调研用 deep-research harness 做了 5 个角度 fan-out 搜索 -> 22 个一手来源 -> 106 条 claim -> 对抗式三票验证. 因撞到 session 限额, 最终只完整验证了 25 条 (9 条三票通过, 1 条被证伪), 其余 15 条因弃权 (abstain) 未完成投票. 故本文对每条结论标注置信度:

- **[已验证]** -- 对抗式三票通过 (3-0 或 2-0), 高置信
- **[一手未验]** -- 来自 mongodb.com / studio3t.com 官方文档且有原文引用, 但因 session 限额未走完投票, 中等置信
- **[代码实证]** -- 直接读本仓库源码确认的事实, 最高置信

来源清单见文末 [引用来源](#引用来源).

## 一句话结论

现有 spec 的方向 (Compass 化三视图 + in-card 编辑 + Clone) 被业界**正面印证**, 路子是对的. 真正的增量价值在三处: ① [展示] 的 Table 视图还很基础, Studio 3T 的 "展开内嵌字段成列 / step-into 数组" 是低成本高回报的升级; ② [CRUD] 的保存链路有**三个真实 bug** (数字 `_id` 静默改不动 / 删字段不持久 / 0 命中仍报成功), 业界的 `findOneAndReplace` 语义正好是干净的修法; ③ spec 完全没规划的 **聚合 pipeline 构建器 / explain 索引洞察 / 大结果集虚拟化**, 是把插件从 "能用" 推到 "优秀" 的差异化点.

## 研究 -> 现有 spec 对齐 (先确认方向没跑偏)

| 业界做法 | 置信 | 现有 spec 对应 | 结论 |
|---|---|---|---|
| Compass 提供 List / JSON / Table 三视图, 各自服务不同阅读任务 (List 看嵌套, JSON 看类型, Table 跨文档比对) | [已验证] | 1a 已实现三视图 | ✅ 方向一致, 已落地 |
| Compass 编辑用显式 Update 按钮提交 / Cancel 丢弃, 逐字段有 revert 图标 | [已验证] | 1b 规划工具栏重组 (Save/Cancel 分组) | ✅ 充实 1b, 见 [B1](#b1-in-card-编辑-1b--对齐-compass-再加-3-个细节) |
| Compass 用颜色标 pending 编辑: 改过的字段黄底, 标记删除的红底 | [已验证] | 1b 规划 "校验/脏状态反馈" | ✅ 给出具体形态 (黄/红) |
| Compass 按视图区分更新语义: List/Table 走 `findOneAndUpdate` (只改动字段), JSON 走 `findOneAndReplace` (整文档替换) | [已验证] | spec 未明确, 现状是 `updateOne` + `$set` 整文档 | ⚠️ 这正是修 bug 的钥匙, 见 [B2](#b2-更新语义与-_id-类型-修-3-个真实-bug) |
| Studio 3T Table 可 "Step Into" 数组 -> 每元素一列编号; "Show Embedded Fields" 把内嵌字段铺成列, 带完整 JSON path | [已验证] | spec 的 Table 仅 `JSON.stringify` 预览 | ➕ Gap, 见 [A2](#a2-table-视图升级-gap--展示主增量) |
| Studio 3T Table 支持双击单元格原地编辑, Enter 提交 | [已验证] | spec 未规划 | ➕ Gap, 见 [B3](#b3-table-原地编辑-可选) |
| Compass Table 中 hover Object/Array 字段点展开按钮, 在新 Table tab 打开嵌套 | [已验证] | -- | ➕ Table 升级备选交互 |

> 唯一被**证伪**的 claim: "Studio 3T 有 List/Tree/Table 三视图切换控件" (0-3). 不要照搬 Studio 3T 的视图模型描述, Compass 的三视图才是可靠参照.

---

## [展示] 优化设计

### A1. 三视图 (已对齐, 维持)

1a 的 List/JSON/Table + 可折叠 [MongoJsonTree.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoJsonTree.tsx) 已正面命中 Compass 模型 [已验证]. 后端 [findDocumentsForBrowser](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts:158) 保留真嵌套结构是关键基建, 不动.

### A2. Table 视图升级 (Gap -- 展示主增量)

**现状** [代码实证]: [MongoTableView.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoTableView.tsx) 把嵌套对象/数组 `JSON.stringify` 成一坨字符串塞进单元格. 跨文档比对嵌套字段时基本没法看.

**业界做法** [已验证]: Studio 3T Table 把内嵌字段 (`Show Embedded Fields`) **铺成额外列**, 父字段前打一个点标记, 每个嵌套列显示完整 JSON path (如 `response.metadata.provider`), 让层级一目了然; 数组可 "Step Into" 拆成编号列.

**落地方案** (按性价比排序, 增量式):

1. **内嵌字段展开为列** (高回报): 列头支持点击展开 `Object` 类型字段 -> 子字段变独立列, 列头显示 dot + 完整 path. 数据已是真嵌套 (1a 保证), 纯前端按路径取值即可, 无新 round-trip.
2. **单元格里的嵌套值** 从裸字符串改为带类型 badge 的紧凑预览 (复用 [mongo-leaf-type.ts](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/mongo-leaf-type.ts) 的 shell-tag 识别), hover 展开 popover 看全量.
3. **列管理** (可选): 列宽自适应 / 隐藏空列 / 按列排序 (点列头). 注意 "拖拽重排 / 批量展开内嵌" 这条来源弃权未验, 列为低优先.

**约束**: 图标一律文字/emoji, webview 无 Tabler 字体 ([[webview-no-tabler-icon-font]]).

### A3. List / Tree 视图细节增强

- [MongoJsonTree.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoJsonTree.tsx) 已有类型 badge + 长串截断, 对齐 Compass List 的 "字段逐项可展开" [已验证]. 增强项: 每个叶子值 hover 出 "copy value / copy path" 微操作 (复用现有 Copy as 能力).
- 顶层默认展开/深层折叠的策略保持 (spec 已定).

---

## [CRUD] 优化设计

### B1. in-card 编辑 (1b) -- 对齐 Compass, 再加 3 个细节

1b 把 [MongoDocumentDetail.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx) 内核抽成可复用编辑器, 卡片内编辑. 在此之上, 用 Compass 的三个**已验证**细节把编辑体验做扎实:

1. **颜色化 dirty** [已验证]: 改过的字段/行黄底, 标记删除的红底. 比现状 "顶部一条 unsaved" 更精确, 让用户提交前看清 diff.
2. **逐字段 revert** [已验证]: hover 改过的行, 左侧出 revert 图标 (文字/emoji 替代), 点一下还原该字段, 不必整体 Cancel.
3. **显式 Update / Cancel 分组** [已验证]: Update 实心主按钮 + Cancel 一组 (右); 工具类 (Copy as / Find) 一组; **Delete 单独隔开远离 Save** (spec 1b 已列, 此处确认其与业界一致).

### B2. 更新语义与 `_id` 类型 (修 3 个真实 bug)

> 这是本次调研**最高价值**的发现: 业界的视图-语义对应关系, 正好对上本仓库保存链路的三个真实缺陷.

**现状链路** [代码实证]: 保存走 [mongo-message-handler.ts:94](/Users/linonon/Workspace/tools/SQL-Extension/src/providers/mongo-message-handler.ts:94)
```
db.coll.updateOne({"_id":"${id}"}, {"$set": <整个文档(去掉_id)>})
```
驱动侧 [autoConvertIds](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts:310) 只把 24-hex 字符串强转 ObjectId.

**Bug 1 -- 非 ObjectId 的 `_id` 静默改不动** [代码实证]: `_id` 被无条件加引号当字符串 `{"_id":"1102025811"}`. 若真实 `_id` 是数字 (Int64) / UUID / Long, filter 类型对不上, `updateOne` 匹配 0 条. 而 [handler:96](/Users/linonon/Workspace/tools/SQL-Extension/src/providers/mongo-message-handler.ts:96) **无视 modifiedCount 一律 post `success: true`** -> 用户以为存好了, 其实没动. (spec 末 "待验证项" 已隐约预感, 此处确诊.)

**Bug 2 -- 删字段不持久** [代码实证]: 编辑器是**整文档 JSON 编辑器**, 但保存用 `$set: 剩余字段`. 用户在编辑器里删掉一个字段, `$set` 不会 `$unset` 它 -> 该字段仍在库里. 与 "所见即所存" 预期相悖.

**Bug 3 -- 0 命中无反馈** [代码实证]: 同 Bug 1 的 `success: true` 问题, 即便正常路径也从不告诉用户 "改了几条 / 匹配 0 条".

**修法** (对齐 Compass `findOneAndReplace` [已验证], 一招解三 bug):

因为编辑器编辑的是**整个文档**, 语义上等价 Compass 的 JSON 视图 -> 应该用 **`replaceOne(filter, 整文档)`** 而非 `updateOne + $set`:
- `replaceOne` 用新文档**整体替换**, 自然删除被去掉的字段 (解 Bug 2);
- `_id` 不放进替换体, 由 filter 定位, 保留原值原类型;
- filter 的 `_id` **不要强行加引号**, 改为复用已有 shell->bson 类型链 (同文档其余字段走的 [convertEjsonToBson](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts:229) 路径), 让 `_id` 带类型回传 (webview 本就持有 shell-tag 形式的 `_id`, 如 `ObjectId("...")` / `NumberLong("...")`), 由转换链重建正确 BSON 类型 (解 Bug 1, 顺带支持 UUID/Long/Decimal128, 不止 24-hex ObjectId);
- handler 读取 `affectedRows` / matchedCount, post 给 webview 显示 "1 document replaced" 或 "0 matched -- nothing changed" (解 Bug 3).

建议在 [MongoDriver](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts) 加专用方法 `replaceDocumentById(db, coll, idTyped, doc)` / `deleteDocumentById(db, coll, idTyped)`, 用结构化参数 + 类型化 `_id` 构 filter, 取代 handler 里的字符串拼接, 从根上消除 "结构化数据 -> shell 字符串 -> 再解析" 的类型损耗. (这也顺带消除 `_id` 含 `"` 时拼接破裂的隐患.)

> 注: 后续若做 Table/List 的**字段级原地编辑** (见 [B3](#b3-table-原地编辑-可选)), 那才对应 Compass 的 `findOneAndUpdate` (只改单字段, 用 `$set`/`$unset`). 两种语义按编辑粒度分用, 与业界一致 [已验证].

### B3. Table 原地编辑 (可选)

[已验证] Studio 3T Table 双击单元格即可改, Enter 提交. 若做, 这是**字段级**更新 -> 用 `updateOne({_id}, {$set:{field:newVal}})` (单字段, `findOneAndUpdate` 语义), 同样要走 [B2](#b2-更新语义与-_id-类型-修-3-个真实-bug) 的类型化 `_id` filter. 体验上是 "电子表格式" 快速改值, 与卡片整文档编辑互补. 优先级低于 B1/B2.

### B4. Clone (1c) -- 维持现有规划

[代码实证] [MongoDocumentCard.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentCard.tsx) Clone 当前禁用. 1c 的方案 (源文档作 seed, `_id` 可编辑, 走 insert 保类型) 正确: [dispatchToCollection insertOne](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts:218) 直接 `convertEjsonToBson` 后 insert, 天然保 `_id` 类型. B2 修好类型链后, Clone 的类型保真也一并受益.

### B5. 删除与影响计数反馈

- 删除确认已有 (extension host modal, 符合项目约定, 不在 webview 用 `window.confirm`). 对齐业界 "删除前确认" [一手未验].
- 与 B3 同源: delete 也应回报 deletedCount, 0 命中要提示 (现状 [handler:107](/Users/linonon/Workspace/tools/SQL-Extension/src/providers/mongo-message-handler.ts:107) 同样字符串拼 `_id` + 一律 success, 有相同的数字 `_id` 删不掉 bug, 随 B2 一起修).

---

## Gap: spec 未覆盖, 决定 "优秀" 与否的差异化项

### C1. 可视化查询构建器 (充实 Phase 2)

[一手未验] Studio 3T Visual Query Builder: 拖字段免写语法, 分 Query (字段+运算符+值, 默认 `$and`) / Projection / Sort 三段, 与文本查询栏**双向镜像**, 改一边同步另一边. 这是 spec Phase 2 "filter builder" 的成熟参照. 现状只有手输 [MongoFilterInput.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoFilterInput.tsx), 门槛高.

### C2. 查询历史 (Phase 2)

spec Phase 2 已列. 业界标配, 保存/复用最近查询, 一键回填. 低成本.

### C3. 增强自动补全 (IntelliSense)

[一手未验] NoSQLBooster / Studio 3T IntelliShell 提供 collection 名 / 字段名 / 运算符 / shell 方法的上下文补全. 现状 [useMongoAutocomplete.ts](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/hooks/useMongoAutocomplete.ts) 已有字段补全, 可扩到运算符 (`$gt`/`$in`/...) 与方法, 提升查询编辑器手感.

### C4. 聚合 Pipeline 构建器 (全新, 高差异化)

[一手未验] Compass 的聚合构建器: 每个 stage 一张可拖拽卡片 + enable/disable 开关, 配 live preview (抽样 ~10 文档实时看每 stage 输出), 还有 Stage Wizard / Focus Mode / Text View 多种编辑模式. 这是 spec 完全没规划的大件, 但也是 "数据库管理插件" 跨入 "数据分析工具" 的关键差异点. 建议**独立 Phase 3**, 体量大, 先评估需求强度再投入 (YAGNI: 若用户群以 CRUD 为主, 可缓做).

### C5. Explain / 索引洞察 (全新)

[一手未验] Compass 有 query plan 可视化与性能洞察 (慢查询 / 缺索引提示). 对常跑查询的用户价值高. 可作轻量切入: 查询面板加一个 "Explain" 按钮, 跑 `.explain()` 展示扫描行数/是否命中索引. 中等优先.

### C6. 大结果集虚拟化 (性能)

[一手未验] 大集合浏览需虚拟滚动 / 无限滚动避免 DOM 爆炸. 现状 driver 默认 `limit=1000` ([dispatchToCollection:209](/Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mongo-driver.ts:209)) + 分页. 若 List/Table 一次渲染上千卡片会卡, 建议列表层做窗口化渲染 (react-window 之类). 中等优先, 数据量大时才痛.

---

## 优先级 Roadmap (建议执行序)

| 优先级 | 项 | 理由 | 体量 |
|---|---|---|---|
| **P0** | [B2](#b2-更新语义与-_id-类型-修-3-个真实-bug) 修 CRUD 三 bug (replaceOne + 类型化 `_id` + 影响计数) | 数据正确性, 静默丢改是最危险的 | 中 |
| **P0** | [B1](#b1-in-card-编辑-1b--对齐-compass-再加-3-个细节) in-card 编辑 + 颜色 dirty + 逐字段 revert | 已是 1b 计划, 业界细节加持 | 中 |
| **P1** | [A2](#a2-table-视图升级-gap--展示主增量) Table 内嵌字段展开为列 | 展示主痛点, 纯前端低成本 | 中 |
| **P1** | [B4](#b4-clone-1c--维持现有规划) Clone (1c) | 收尾既定分期, 受益于 B2 | 小 |
| **P2** | [C1](#c1-可视化查询构建器-充实-phase-2)/[C2](#c2-查询历史-phase-2) 查询构建器 + 历史 | 降低查询门槛 | 中 |
| **P2** | [B3](#b3-table-原地编辑-可选) Table 原地编辑 / [A3](#a3-list--tree-视图细节增强) copy 微操作 | 锦上添花 | 小 |
| **P3** | [C5](#c5-explain--索引洞察-全新) Explain / [C6](#c6-大结果集虚拟化-性能) 虚拟化 | 进阶, 按需 | 中 |
| **P3?** | [C4](#c4-聚合-pipeline-构建器-全新-高差异化) 聚合构建器 | 差异化大件, 先验证需求 (YAGNI) | 大 |

执行纪律: 沿用现有 TDD + Vitest + 改 webview 后 `cd webview-ui && npm run build` (见 [build.md](/Users/linonon/Workspace/tools/SQL-Extension/.claude/rules/build.md)). 每项独立小步提交 (见 [commit.md](/Users/linonon/Workspace/tools/SQL-Extension/.claude/rules/commit.md)).

---

## 引用来源

一手文档 (primary):

- Compass 文档视图 (三视图 / Table 嵌套展开): https://www.mongodb.com/docs/compass/documents/view/ [已验证]
- Compass 修改文档 (更新语义 / 颜色 dirty / Update-Cancel-revert): https://www.mongodb.com/docs/compass/current/documents/modify/ [已验证]
- Studio 3T 探索数组与字段 (Step Into / Show Embedded Fields / JSON path): https://studio3t.com/knowledge-base/articles/explore-mongodb-arrays-fields/ [已验证]
- Studio 3T Table View (原地编辑 / step into cell/column): https://studio3t.com/knowledge-base/articles/table-view/ [已验证]
- Compass 删除文档: https://www.mongodb.com/docs/compass/documents/delete/ [一手未验]
- Studio 3T 可视化查询构建器: https://studio3t.com/knowledge-base/articles/visual-query-builder/ [一手未验]
- Compass 聚合 pipeline 构建: https://www.mongodb.com/docs/compass/create-agg-pipeline/ [一手未验]
- Compass query plan / 性能洞察: https://www.mongodb.com/docs/compass/query-plan/ , https://www.mongodb.com/docs/compass/manage-data/performance-insights/ [一手未验]
- NoSQLBooster (IntelliSense / fluent query): https://nosqlbooster.com/ [一手未验]
- Studio 3T IntelliShell 补全: https://studio3t.com/knowledge-base/articles/mongo-shell-intellishell/ [一手未验]
- MongoDB 官方 VS Code 扩展 (平台约束参照): https://www.mongodb.com/docs/mongodb-vscode/crud-ops/ , https://www.mongodb.com/docs/mongodb-vscode/databases-collections/ [一手未验]
- 大数据集无限滚动 (虚拟化参照): https://artsy.github.io/blog/2013/02/15/infinite-scroll-with-mongodb/ [blog]
