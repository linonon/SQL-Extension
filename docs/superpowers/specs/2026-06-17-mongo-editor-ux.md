# Mongo in-card 文档编辑器 UI/UX 升级设计

## 背景与目标

in-card JSON 编辑器目前是纯 monospace textarea (无语法配色) + 纯文字工具栏 + 简陋 `_id` 行,
用户反馈"太简陋也不直观". 目标: 做成接近 Compass / 真实代码编辑器的体验 ——
语法高亮 + 行号 + 清晰的工具栏层级 + JSON 校验反馈. 仅 JSON 模式; Fields 模式不在本次范围.

无后端改动. 涉及 [HighlightEditor.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/HighlightEditor.tsx),
[MongoDocumentDetail.tsx](/Users/linonon/Workspace/tools/SQL-Extension/webview-ui/src/components/mongo-browser/MongoDocumentDetail.tsx) 与 mongo-browser.css.

## 约束

- webview 无 Tabler 图标字体: 一律用文字 / 安全 unicode 字形 (●, ✕, ▾, ↺).
- 保持已修的自适应内容高度 (backdrop 在普通流撑高, textarea 绝对覆盖).
- 不破坏现有能力: Ctrl+F 搜索高亮, 字段自动补全, Copy as, dirty 追踪, save-on-switch (saveSignal) / onSaveError.
- 配色须在 VS Code light/dark 两种主题下都可读 (用固定中间调色板, 不依赖主题 token 变量).
- jsdom 无布局: 纯逻辑 (tokenizer / 校验行号映射) 单测; 对齐与观感由用户在真实 webview 验证.

## 组件设计

### 1. 语法高亮 (tokenizer + 着色 backdrop)

新增纯函数 `tokenizeMongoJson(text): Token[]`, `Token = { text, type }`,
type ∈ `key | string | number | keyword | bson | punct | plain`. 规则:

- 引号字符串: 其后 (跳过空白) 紧跟 `:` -> `key`, 否则 `string`. 支持转义.
- 数字: `-?\d+(\.\d+)?([eE][+-]?\d+)?` -> `number`.
- 标识符: `true/false/null` -> `keyword`; BSON 构造器 (ObjectId/ISODate/Date/NumberLong/Long/
  NumberInt/Int32/NumberDecimal/Decimal128/MinKey/MaxKey/new) -> `bson`; 其它 -> `plain`.
- `{}[]:,` -> `punct`; 空白 (含换行) -> `plain`.
- 不变量: 所有字符原样保留 (拼接 token.text === 原文), 保证与 textarea 对齐.

backdrop 由"透明文字 + 仅搜索 mark"改为"着色文字". textarea 文字改透明 (caret 仍可见),
用户看到的着色文字来自 backdrop, 输入进透明 textarea. 搜索 mark 仍在 backdrop 内
(命中子串包 `<mark>`, 不破坏 token 颜色).

配色 (中间调, 双主题可读): key=#378ADD, string=#D85A30, number=#BA7517,
bson=#7F77DD, keyword=#1D9E75, punct=text-tertiary.

### 2. 行号 gutter

backdrop 改为按逻辑行渲染: 每行一个 `[行号 | 代码]` 行 (flex), 行号顶对齐, 代码 pre-wrap.
textarea `padding-left` = gutter 宽度 (按行数位数 `Nch + 常量` 计算), 文字换行宽度与代码列一致,
故逻辑行高度逐行匹配 -> 行号与 textarea 文本逐行对齐 (换行的续行不再有号, 与 VS Code 一致).

### 3. 工具栏重组

`Fields | JSON` 分段控件 (左); 右侧依次: `Copy as ▾` / `Find` (工具) | `● Unsaved` (脏标, 仅 dirty 时) |
`Cancel` | `Save` (实心主按钮, JSON 非法或未改动时 disabled). 破坏性的 `Delete` 移到底部左侧,
danger 描边, 与 Save 隔开, 仍走确认.

### 4. JSON 校验反馈

编辑变更时尝试解析 (复用 convertShellToJson + JSON.parse). 失败:
- 顶部红色错误条: 文案 + 行号 (从 JSON.parse 错误 message 的 position 映射到行).
- 该行号在 gutter 标红.
- `Save` disabled.

新增纯函数 `jsonErrorLine(text, errorMessage): number | null` 做 position->行 映射, 单测.

## 测试策略

- `tokenizeMongoJson`: 各类型 token 序列 + 字符保真 (拼接 === 原文) + key/string 区分 + BSON 识别.
- `jsonErrorLine`: 从含 position 的错误信息映射到行号; 无 position 返回 null.
- 组件层: 已有 HighlightEditor / MongoDocumentDetail 测试保持通过; 新增"非法 JSON -> Save disabled + 错误条"测试.
- 对齐 / 观感: 真实 webview 人工验证 (jsdom 无布局).
