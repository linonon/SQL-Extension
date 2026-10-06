# Project Conventions

## SQL Generation

- **预填进编辑器给用户看的 SQL 不 qualify database name**: 编辑器的查询已经在 panel 的目标 database context 下执行, `buildSelectSql` 不应传 `database` 参数. 生成 `SELECT * FROM table` 而非 `SELECT * FROM database.table`.
- **在共享连接池上执行的生成写语句必须 qualify database name (MySQL)**: `buildInsert` / `buildUpdate` / `buildBatchDelete` 生成的 INSERT / UPDATE / DELETE 在共享池上执行, 池的默认库不是 panel 的库, 必须传 `database` 生成 `database.table`.

## Column Metadata

- **MySQL 列类型用 `COLUMN_TYPE` 而非 `DATA_TYPE`**: `information_schema.COLUMNS.DATA_TYPE` 只返回基本类型名 (如 `varchar`), `COLUMN_TYPE` 返回完整类型 (如 `varchar(255)`).

## Delete Operations

- **所有删除操作必须有确认步骤**: 确认对话框统一在 extension host 中使用 `vscode.window.showWarningMessage({ modal: true })`, 放在真正执行删除的那个 handler 里, 确认通过后紧接着执行 (如 `sql-message-handler.ts` 的 `deleteRows` / `alterTable`, `table-view-provider.ts` 里 Redis / Mongo 分支的删除消息). **禁止在 webview 中使用 `window.confirm()`** -- `window.confirm()` 在 VS Code webview 中不可靠, 会导致操作静默失败 (消息发不出去).

## SSH Tunnel

- **所有数据库类型都必须支持 SSH Tunnel**: 新增任何数据库 driver 时, 连线配置页面必须包含 SSH Tunnel 选项. 不要用 `driverType` 条件排除任何数据库类型的 SSH 功能.

## Icons

- **每个 driverType 必须有 4 个 SVG icon**: `resources/{driverType}-{connected|disconnected}-{light|dark}.svg`. 新增 driver 时必须同时创建这 4 个文件.
- **icon 必须填满 24x24 viewBox**: 不要用 `scale(0.75)` 或其他缩小 transform. 图形元素直接使用 0-24 坐标, 尽量占满整个 viewBox.
- **connected 版本加绿色状态点**: `<circle cx="19.5" cy="19.5" r="4.5" fill="#22C55E" stroke="..." stroke-width="1.5"/>`, dark 主题 stroke="#1E1E1E", light 主题 stroke="#FFFFFF".
- **dark/light 主题颜色区分**: dark 用亮色 (品牌色或 `#E0E0E0`), light 用深色 (深品牌色或 `#231F20`).
