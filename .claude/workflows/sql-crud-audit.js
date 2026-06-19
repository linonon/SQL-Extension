export const meta = {
  name: 'sql-crud-audit',
  description: 'Adversarial robustness/security/architecture audit of the MySQL+Postgres CRUD subsystem',
  phases: [
    { title: 'Find', detail: '7 finder angles over the SQL CRUD surface' },
    { title: 'Verify', detail: 'adversarial recall-biased verification of bug/security findings' },
  ],
}

// 受审文件清单 (绝对路径), 所有 finder 共享
const FILES = `
后端 (ext-host, src/):
- /Users/linonon/Workspace/tools/SQL-Extension/src/utils/sql-builder.ts  (CRUD SQL 生成: buildSelect/Count/Insert/Update/Delete/BatchDelete, identifier 转义, 参数化)
- /Users/linonon/Workspace/tools/SQL-Extension/src/utils/alter-table-builder.ts  (DDL 生成: ADD/DROP/RENAME/MODIFY COLUMN, default 子句)
- /Users/linonon/Workspace/tools/SQL-Extension/src/services/query-service.ts  (fetchRows/insertRow/updateRow/deleteRow 调 builder + driver)
- /Users/linonon/Workspace/tools/SQL-Extension/src/drivers/mysql-driver.ts  (mysql2 pool, execute, executeCancellable, USE database, listColumns 等)
- /Users/linonon/Workspace/tools/SQL-Extension/src/drivers/pg-driver.ts  (pg pool, execute, executeCancellable, type parsers)
- /Users/linonon/Workspace/tools/SQL-Extension/src/providers/table-view-provider.ts  (webview message handler: CRUD case 在 line 280-470, batchUpdate line 349, executeQuery DANGEROUS_PATTERN line 364, 外层 catch line 879)
- /Users/linonon/Workspace/tools/SQL-Extension/src/mcp/sql-validator.ts  (readonly SQL 校验: isReadonlySQL, isMultiStatement, enforceLimit)

前端 (webview, webview-ui/src/):
- /Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/utils/sql-builder.ts  (buildSelectSql, 与后端 sql-builder 重复的 escapeIdentifier/qualifyTable)
- /Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/hooks/useBatchEdits.ts  (pending cell edits, buildUpdates 聚合)
- /Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/data-grid/DataGrid.tsx  (数据网格: 单元格编辑/插入/删除/批量保存 UI)
- /Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/data-grid/DataGridToolbar.tsx
- /Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/edit-table/EditTable.tsx  (改表结构: 列名/类型/default/comment 自由文本 -> alterTable)
- /Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/common/CloneRowModal.tsx  (克隆行为新建, 所有值按 string 传)
`

const CONTEXT = `
这是一个 VS Code 数据库客户端扩展. 审查范围: **MySQL 和 PostgreSQL 的数据 CRUD 子系统** (mongodb/redis/kafka/rabbitmq 不在范围内, 出现 driverType==='mongodb' 分支可忽略).

架构: webview (React) 通过 postMessage 把结构化 CRUD 请求发给 ext-host; ext-host 用 sql-builder 生成参数化 SQL, 经 driver 执行. 写操作 (insert/update/delete) 走参数化占位符 (? / $n); 标识符 (表名/列名) 走 escapeIdentifier 反引号/双引号转义. DDL (alter table) 和 default 子句是字符串拼接.

威胁模型: **单用户本地工具, 用户操作自己的数据库, 且有一个可写任意 SQL 的 query editor**. 因此 "用户能注入 SQL 攻击自己的库" 不算有意义的安全漏洞 (attacker==victim, 等价于直接写 SQL). 真正有价值的发现是: (a) 数据完整性/正确性 bug (静默写错值, 部分失败留下不一致状态, 误删/误改全表); (b) 防御性编程缺口 (类似 "非法 ISODate 仍能存库" 这种语法合法但值非法/边界被静默接受); (c) 真正的健壮性 bug (崩溃, 卡死 spinner, 资源泄漏); (d) 代码/架构整洁性 (重复, god file, 脆弱字符串处理).

重点关注用户原话: "CRUD 时的防御性编程检测是否完整" + "像 ISODate 格式错误还能存储这类 bug 的防御".
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'category', 'severity', 'summary', 'failure_scenario'],
        properties: {
          file: { type: 'string', description: '绝对路径' },
          line: { type: 'number' },
          category: { type: 'string', enum: ['bug', 'security', 'cleanup', 'architecture'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          summary: { type: 'string', description: '一句话描述问题' },
          failure_scenario: { type: 'string', description: '具体的触发输入/状态 -> 错误后果; 或对 cleanup/architecture 描述具体代价' },
        },
      },
    },
  },
}

const ANGLES = [
  {
    key: 'crud-correctness',
    prompt: `角度 A — CRUD 正确性 & 数据完整性. 逐行读 sql-builder.ts / query-service.ts / 两个 driver / table-view-provider 的 CRUD case. 找: 空输入 (空 row / 空 changes / 空 primaryKeys) 导致的非法 SQL 或误改全表; 多行批量写无事务导致部分失败留下不一致 (batchUpdate line 349 循环 updateRow 无 BEGIN/COMMIT); buildBatchDelete 假设所有条目同 key (Object.keys(list[0])); 无主键表的 update/delete 行为; null/undefined 参数被静默当成匹配 0 行的 no-op; insert 空 row 在 mysql vs pg 行为不一致.`,
  },
  {
    key: 'defensive-validation',
    prompt: `角度 B — 防御性校验完整性 (用户最关心的). 找语法合法但值非法/边界被静默接受写库的路径 (ISODate-class). 例如: webview 文本输入把数字列写成非数字字符串 -> 依赖 DB sql_mode 是否报错 (非严格模式静默截断/置0); CloneRowModal 把所有值当 string 传 (line 79); 没有任何 CRUD 入口校验值与列类型/可空性的匹配; default 子句 buildDefaultClause 把 CURRENT_TIMESTAMP 等函数默认值当字符串字面量加引号 (line 15 正则只认纯数字). 区分: 哪些应该客户端拦, 哪些应该依赖 DB strict mode (不要建议重造 DB 类型系统). 但要指出真正的静默数据损坏路径.`,
  },
  {
    key: 'injection-safety',
    prompt: `角度 C — 输入安全 / 注入面 (注意威胁模型: 单用户本地, attacker==victim 的自注入不算漏洞). 真正有价值: identifier 转义是否正确且无遗漏 (sql-builder escapeIdentifier, alter-table escId); alter-table 的 col.dataType / mod.dataType 是自由文本原样拼进 DDL 且无法被引号包裹 (line 52/84/94) -- 在 PG simple query protocol 下能否触发多语句 (client.query 单字符串可跑多语句); mysql2 是否开了 multipleStatements; sql-validator isMultiStatement 去字符串常量的正则能否被绕过 (反斜杠转义 \\' / PG dollar-quoting / 反引号). 重点是 "会不会因转义遗漏导致即便正常使用也生成错误 SQL", 以及 readonly 闸 (isReadonlySQL) 能否被绕过执行写操作.`,
  },
  {
    key: 'robustness-crash-hang',
    prompt: `角度 D — 运行时健壮性: 崩溃 / 卡死 / 资源泄漏. 找: updateRow case (line 316) 成功不回 ack 消息 -> 前端若等 ack 会卡死; batchUpdate 失败时 outer catch 回 batchUpdateResult success:false 但已写入的行不会回滚; executeCancellable 里 conn/client 在 USE database 抛错时是否泄漏 (mysql-driver line 168-197); cancel() 调 KILL QUERY / pg_cancel_backend 的竞态; pool error handler 只 console.error; Number(countResult...) / String() 转换在异常类型上的行为; schemaCache 无上限. 给出具体触发场景.`,
  },
  {
    key: 'frontend-crud-ui',
    prompt: `角度 E — webview CRUD UI 健壮性. 读 DataGrid.tsx / DataGridToolbar.tsx / useBatchEdits.ts / EditTable.tsx / CloneRowModal.tsx. 找: useBatchEdits addChange 用 String(old)===String(new) 判等 -> null vs 'null' vs '' 混淆, 数字 1 vs '1' 误判无改动而丢失编辑; buildUpdates 无主键时静默返回 [] (用户点保存无反应); 删除/批量保存前是否有确认 (规范要求 ext-host modal, 禁止 window.confirm); EditTable 自由文本列类型无校验直接提交 alter; 编辑中后台 refetch 覆盖未保存草稿; 错误状态展示缺失.`,
  },
  {
    key: 'architecture-cleanup',
    prompt: `角度 F — 代码整洁 / 架构重构 (category 用 cleanup 或 architecture). 找: 后端 src/utils/sql-builder.ts 与前端 webview-ui/src/utils/sql-builder.ts 重复实现 escapeIdentifier/qualifyTable (两份易漂移); table-view-provider.ts 1034 行 god file (所有 driver 的所有消息混在一个 handleMessage switch + if 链); buildBatchDelete 用 t.slice(1,-1) 脆弱字符串剥括号; query-service 各方法是 builder+execute 的薄包装是否有价值; buildDefaultClause 两个 if 分支返回相同代码 (line 18-21); alter-table mysql/pg 分支里 if/else 两边相同语句 (line 35-39, 70-74). 给出具体重构建议和收益.`,
  },
  {
    key: 'conventions',
    prompt: `角度 G — CLAUDE.md 规范违反. 读 /Users/linonon/.claude/CLAUDE.md, /Users/linonon/Workspace/tools/SQL-Extension/CLAUDE.md 及 .claude/rules/*.md. 检查受审代码是否违反: 删除操作必须 ext-host modal 确认 (禁 window.confirm); 不在生成 SQL 里 qualify database (但注意 conventions 说的是 buildSelectSql 不传 database -- 看实际是否一致); MySQL 用 COLUMN_TYPE 而非 DATA_TYPE; 注释只写当前事实不写历史; 标点用英文. 只报能精确引用规则原文 + 违规代码行的. 找不到就返回空.`,
  },
]

phase('Find')
const finderResults = await parallel(
  ANGLES.map((a) => () =>
    agent(`${CONTEXT}\n\n受审文件:\n${FILES}\n\n${a.prompt}\n\n用 Read/Grep 实际读代码再下结论 (禁止凭空猜测接口). 每条 finding 给真实绝对路径+行号. 最多 7 条, 质量优先. 输出 JSON.`,
      { label: `find:${a.key}`, phase: 'Find', schema: FINDING_SCHEMA, effort: 'high' }
    )
  )
)

const all = finderResults.filter(Boolean).flatMap((r) => r.findings || [])
log(`finders 产出 ${all.length} 条候选`)

// 去重: 同文件 + 邻近行 (±3) + 同 category 视为重复, 保留 severity 更高的
const sevRank = { critical: 0, high: 1, medium: 2, low: 3 }
const deduped = []
for (const f of all) {
  const dup = deduped.find((d) =>
    d.file === f.file && d.category === f.category && Math.abs((d.line || 0) - (f.line || 0)) <= 3
  )
  if (!dup) { deduped.push(f); continue }
  if (sevRank[f.severity] < sevRank[dup.severity]) {
    deduped[deduped.indexOf(dup)] = f
  }
}
log(`去重后 ${deduped.length} 条`)

// bug/security 需对抗式验证; cleanup/architecture 直接判定 (需要 judgment 不是 refute)
const toVerify = deduped.filter((f) => f.category === 'bug' || f.category === 'security')
const cleanups = deduped.filter((f) => f.category === 'cleanup' || f.category === 'architecture')

phase('Verify')
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning', 'recommend_fix'],
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
    reasoning: { type: 'string', description: '引用真实代码行证明; REFUTED 必须给出代码层面的反证' },
    recommend_fix: { type: 'string', description: '若 CONFIRMED/PLAUSIBLE, 给出最小修复方向 (KISS); 否则空' },
  },
}

const verified = await parallel(
  toVerify.map((f) => () =>
    agent(`${CONTEXT}\n\n对抗式验证以下发现 (recall-biased: 现实可达的状态默认 PLAUSIBLE, 只有能从代码构造反证时才 REFUTED; 注意威胁模型, 自注入类安全发现应 REFUTED). 实际 Read 相关代码再判定.\n\n发现:\nfile: ${f.file}:${f.line}\ncategory: ${f.category} severity: ${f.severity}\nsummary: ${f.summary}\nscenario: ${f.failure_scenario}\n\n输出 JSON verdict.`,
      { label: `verify:${f.file.split('/').pop()}:${f.line}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' }
    ).then((v) => ({ ...f, ...v }))
  )
)

const survivors = verified.filter(Boolean).filter((f) => f.verdict !== 'REFUTED')
const refuted = verified.filter(Boolean).filter((f) => f.verdict === 'REFUTED')

return {
  confirmed_bugs: survivors.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]),
  refuted: refuted.map((f) => ({ file: f.file, line: f.line, summary: f.summary, reasoning: f.reasoning })),
  cleanup_architecture: cleanups.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]),
  stats: { candidates: all.length, deduped: deduped.length, verified: toVerify.length, survived: survivors.length, refuted: refuted.length, cleanup: cleanups.length },
}
