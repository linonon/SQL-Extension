# Test Plan - SQL Extension

## 后端 (Extension 侧)

### sql-builder.ts

#### 辅助函数
- [ ] `escapeIdentifier()` - 正常 identifier 转义 (abc -> "abc")
- [ ] `escapeIdentifier()` - 包含引号的 identifier (a"b -> "a""b")
- [ ] `escapeIdentifier()` - 空字符串 identifier ("")
- [ ] `escapeIdentifier()` - 特殊字符 (SQL keywords, 空格, Unicode)
- [ ] `getPlaceholder()` - MySQL 返回 ? 占位符
- [ ] `getPlaceholder()` - PostgreSQL 返回 $1, $2, ... 占位符
- [ ] `getPlaceholder()` - 无效 driver type (降级到 MySQL)
- [ ] `qualifyTable()` - MySQL 带 database 前缀 (db.table)
- [ ] `qualifyTable()` - PostgreSQL 不带 database 前缀
- [ ] `qualifyTable()` - MySQL 无 database 参数
- [ ] `qualifyTable()` - 表名和 database 都包含特殊字符

#### buildSelect()
- [ ] MySQL - 正常 SELECT 语句, 验证 LIMIT ? OFFSET ? 和参数顺序
- [ ] PostgreSQL - 正常 SELECT 语句, 验证 $1 $2 和参数顺序
- [ ] MySQL - 带 database 前缀
- [ ] PostgreSQL - 不带 database 前缀
- [ ] offset=0, limit=100 边界条件
- [ ] offset=0, limit=0 (应该返回 0 行)
- [ ] 负数 offset/limit (交给数据库报错或 service 层校验)

#### buildCount()
- [ ] MySQL - SELECT COUNT(*) 语句
- [ ] PostgreSQL - SELECT COUNT(*) 语句
- [ ] 带/不带 database 参数

#### buildInsert()
- [ ] MySQL - 正常 INSERT, 验证列名转义, 占位符顺序, params 顺序
- [ ] PostgreSQL - 正常 INSERT
- [ ] 空对象 (0 列) - 应该生成 INSERT INTO table () VALUES ()
- [ ] 单列 INSERT
- [ ] 多列 INSERT (10+ 列)
- [ ] 列名包含特殊字符 (引号, 空格, SQL keywords)
- [ ] 值为 null, undefined, 空字符串, 数字, boolean
- [ ] 值为 SQL injection 攻击字符串 (' OR 1=1 --)

#### buildUpdate()
- [ ] MySQL - 正常 UPDATE, 验证 SET 和 WHERE 子句, 参数顺序
- [ ] PostgreSQL - 正常 UPDATE
- [ ] 单列 change, 单列 primary key
- [ ] 多列 change, 复合 primary key
- [ ] 空 changes 对象 (应该生成无效 SQL 或抛错)
- [ ] 空 primaryKeys 对象 (应该生成无 WHERE 或抛错)
- [ ] primary key 值为 null
- [ ] 列名包含特殊字符
- [ ] SQL injection 防护

#### buildDelete()
- [ ] MySQL - 正常 DELETE, 验证 WHERE 子句
- [ ] PostgreSQL - 正常 DELETE
- [ ] 单列 primary key
- [ ] 复合 primary key (3+ 列)
- [ ] 空 primaryKeys 对象
- [ ] primary key 值为 null
- [ ] SQL injection 防护

---

### mysql-driver.ts

#### connect()
- [ ] 正常连接 (host, port, username, password, database)
- [ ] 连接失败 - 错误的 host/port
- [ ] 连接失败 - 错误的 username/password
- [ ] 连接失败 - 不存在的 database
- [ ] 连接超时 (5秒)
- [ ] pool 创建成功后验证 getConnection() 可用
- [ ] 重复调用 connect() (应该覆盖旧 pool)

#### disconnect()
- [ ] 正常断开连接
- [ ] 已经断开的情况下再次调用 (idempotent)
- [ ] disconnect 后 pool 为 null

#### isConnected()
- [ ] 未连接时返回 false
- [ ] 连接后返回 true
- [ ] 断开后返回 false

#### listDatabases()
- [ ] 返回 database 列表 (排除 system databases 可选)
- [ ] 未连接时抛错
- [ ] 空结果 (不太可能, 但需处理)

#### listTables()
- [ ] 返回指定 database 的 table 列表 (name, schema, rowCount)
- [ ] 空 database (0 tables)
- [ ] 大量 tables (100+)
- [ ] rowCount 为 NULL 时降级为 0
- [ ] 不存在的 database 返回空数组或报错
- [ ] 参数化查询防护 SQL injection

#### listColumns()
- [ ] 返回指定 table 的 column 列表
- [ ] 验证 isPrimaryKey 识别 (PRI)
- [ ] 验证 nullable 识别 (YES/NO)
- [ ] 验证 defaultValue (NULL, 字符串, 数字)
- [ ] 验证 extra (auto_increment)
- [ ] 不存在的 table 返回空数组或报错
- [ ] 参数化查询防护 SQL injection

#### execute()
- [ ] SELECT - 返回 rows, columns, executionTime
- [ ] INSERT - 返回 affectedRows
- [ ] UPDATE - 返回 affectedRows
- [ ] DELETE - 返回 affectedRows
- [ ] 带参数化查询
- [ ] 空参数数组
- [ ] NULL 参数
- [ ] 未连接时抛错
- [ ] SQL 语法错误时抛出异常
- [ ] 查询超时 (长查询)

#### assertConnected()
- [ ] pool 为 null 时抛出 "MySQL driver is not connected"

---

### pg-driver.ts

#### connect()
- [ ] 正常连接
- [ ] 连接失败 - 错误的 host/port
- [ ] 连接失败 - 错误的 username/password
- [ ] 连接失败 - 不存在的 database
- [ ] 连接超时 (5秒)
- [ ] pool 创建成功后验证 client 可用

#### disconnect()
- [ ] 正常断开连接
- [ ] idempotent

#### isConnected()
- [ ] 状态正确

#### listDatabases()
- [ ] 返回 database 列表 (排除 template databases)
- [ ] 未连接时抛错

#### listTables()
- [ ] 返回 public schema 的 table 列表
- [ ] schema 过滤 (只返回 public)
- [ ] rowCount 来自 pg_stat_user_tables
- [ ] rowCount 为 NULL 时降级为 0
- [ ] _database 参数被忽略 (仅为接口兼容)

#### listColumns()
- [ ] 返回 column 列表
- [ ] 验证 isPrimaryKey (JOIN table_constraints)
- [ ] 验证 nullable (YES/NO)
- [ ] 验证 defaultValue
- [ ] 复合 primary key 识别
- [ ] 参数化查询 $1

#### execute()
- [ ] SELECT - 返回 rows, columns, executionTime
- [ ] INSERT/UPDATE/DELETE - 返回 affectedRows (rowCount)
- [ ] 带参数 $1, $2, ...
- [ ] 未连接时抛错
- [ ] SQL 语法错误

#### assertConnected()
- [ ] pool 为 null 时抛出 "PostgreSQL driver is not connected"

---

### connection-manager.ts

#### getConnections()
- [ ] 返回所有 connection configs
- [ ] 空列表 (首次启动)

#### getConnectionInfo()
- [ ] 返回 ConnectionInfo[] (config + state)
- [ ] 未连接的 connection 状态为 'disconnected'
- [ ] 已连接的 connection 状态为 'connected'

#### addConnection()
- [ ] 添加新 connection, 存储到 globalState
- [ ] 存储 password 到 credentialStore
- [ ] 触发 onDidChange 事件
- [ ] 重复 id 处理 (覆盖或报错)

#### removeConnection()
- [ ] 删除 connection
- [ ] 先调用 disconnect()
- [ ] 从 globalState 删除
- [ ] 从 credentialStore 删除 password
- [ ] 触发 onDidChange 事件
- [ ] 删除不存在的 connection (静默处理或报错)

#### connect()
- [ ] 找到 config, 获取 password, 创建 driver, 连接成功
- [ ] 状态转换: disconnected -> connecting -> connected
- [ ] 连接失败时状态回退到 disconnected
- [ ] 触发 onDidChange 事件
- [ ] connection id 不存在时抛错 "Connection not found"
- [ ] password 不存在时抛错 "Password not found"
- [ ] driver 连接失败时抛出原始错误

#### disconnect()
- [ ] 调用 driver.disconnect()
- [ ] 从 drivers Map 删除
- [ ] 状态设为 'disconnected'
- [ ] 触发 onDidChange 事件
- [ ] 已断开的 connection 再次调用 (idempotent)

#### getDriver()
- [ ] 返回已连接的 driver
- [ ] 未连接时抛错 "No active connection"

#### getState()
- [ ] 返回正确的 ConnectionState
- [ ] 未知 id 返回 'disconnected'

#### createDriver()
- [ ] driverType='mysql' 返回 MySQLDriver
- [ ] driverType='postgresql' 返回 PgDriver
- [ ] 无效 driverType 抛错 "Unsupported driver type"

#### dispose()
- [ ] 断开所有 driver
- [ ] 清空 drivers Map
- [ ] dispose EventEmitter
- [ ] 静默处理 driver.disconnect() 错误

---

### credential-store.ts

#### getPassword()
- [ ] 返回存储的 password
- [ ] 不存在时返回 undefined

#### setPassword()
- [ ] 存储 password 到 secrets

#### deletePassword()
- [ ] 删除 password

---

### query-service.ts

#### fetchRows()
- [ ] 先 buildCount 获取 total, 再 buildSelect 获取分页数据
- [ ] 返回 PagedResult (columns, rows, total, page)
- [ ] offset=0, limit=100
- [ ] offset=100, limit=100 (第二页)
- [ ] 空表 (total=0, rows=[])
- [ ] total 为 NULL 时降级为 0
- [ ] MySQL 和 PostgreSQL 分别测试

#### insertRow()
- [ ] 调用 buildInsert, 执行 execute
- [ ] 返回 QueryResult

#### updateRow()
- [ ] 调用 buildUpdate, 执行 execute
- [ ] 返回 QueryResult

#### deleteRow()
- [ ] 调用 buildDelete, 执行 execute
- [ ] 返回 QueryResult

#### executeRaw()
- [ ] 直接执行用户 SQL (不自动加 database 前缀)
- [ ] SELECT 语句
- [ ] INSERT/UPDATE/DELETE 语句
- [ ] 多语句 (可选, 取决于 driver 支持)
- [ ] SQL 语法错误
- [ ] SQL injection (用户自行负责, 但需提示)

---

### schema-service.ts

#### listDatabases()
- [ ] 调用 driver.listDatabases()

#### listTables()
- [ ] 调用 driver.listTables()

#### listColumns()
- [ ] 调用 driver.listColumns()

---

### connection-tree-provider.ts

#### getTreeItem()
- [ ] 返回 TreeItem 本身

#### getChildren()
- [ ] 无 element 时返回 root items (ConnectionTreeItem[])
- [ ] ConnectionTreeItem -> DatabaseTreeItem[]
- [ ] DatabaseTreeItem -> TableTreeItem[]
- [ ] TableTreeItem -> ColumnTreeItem[]
- [ ] 其他 element 返回空数组

#### getRootItems()
- [ ] 返回所有 connection 的 TreeItem
- [ ] 空列表

#### getDatabaseItems()
- [ ] 调用 schemaService.listDatabases()
- [ ] driver 不存在时显示错误消息, 返回空数组

#### getTableItems()
- [ ] 调用 schemaService.listTables()
- [ ] 错误处理

#### getColumnItems()
- [ ] 调用 schemaService.listColumns()
- [ ] 错误处理

#### refresh()
- [ ] 触发 onDidChangeTreeData 事件

---

### tree-items.ts

#### ConnectionTreeItem
- [ ] 正确设置 label, description, contextValue, iconPath
- [ ] state='connected' 时 icon 为 'database', collapsibleState 为 Collapsed
- [ ] state='disconnected' 时 icon 为 'debug-disconnect', collapsibleState 为 None

#### DatabaseTreeItem
- [ ] 正确设置 label, contextValue, iconPath

#### TableTreeItem
- [ ] 正确设置 label, description (rowCount), contextValue, iconPath
- [ ] command 指向 'sqlext.openTable'

#### ColumnTreeItem
- [ ] 正确设置 label, description (dataType, PK, NOT NULL)
- [ ] isPrimaryKey=true 时 icon 为 'key'
- [ ] isPrimaryKey=false 时 icon 为 'symbol-field'

---

## 前端 (Webview 侧)

### App.tsx

#### 状态管理
- [ ] 初始 view 为 null, 显示 "Loading..."
- [ ] 接收 viewInit 消息后设置 view 和 viewContext

#### handleMessage
- [ ] 正确处理 viewInit 消息

#### useEffect ready
- [ ] mount 后发送 ready 消息
- [ ] listener 挂载后再发送 (不丢 viewInit)

#### view 路由
- [ ] view='table' 渲染 DataGrid
- [ ] view='query' 渲染 QueryEditor
- [ ] view='connection-form' 渲染 ConnectionForm
- [ ] 无效 view 显示 "Unknown view"

---

### DataGrid.tsx

#### 数据加载
- [ ] mount 时调用 fetchData(0)
- [ ] fetchData() 发送 fetchRows 消息
- [ ] 接收 tableData 消息更新 columns, rows, page
- [ ] 接收 error 消息更新 error 状态
- [ ] loading 状态管理

#### 分页
- [ ] handlePageChange() 调用 fetchData(newOffset)
- [ ] 负数 offset 被 clamp 到 0

#### 排序
- [ ] TanStack Table sorting 功能
- [ ] 点击列头切换排序
- [ ] 排序指示器 (^ v)

#### 行选择
- [ ] 单击行选中 (替换选择)
- [ ] Ctrl/Cmd+单击切换选择
- [ ] 多选后 selectedRows Set 正确

#### 单元格编辑
- [ ] 双击单元格进入编辑模式
- [ ] 编辑 input 显示, autoFocus
- [ ] 输入值改变, editingCell.value 更新
- [ ] Enter 提交编辑 (commitEdit)
- [ ] Escape 取消编辑
- [ ] Blur 提交编辑
- [ ] 值未改变时不发送 updateRow 消息
- [ ] NULL 值显示为空字符串, 提交时转回 NULL
- [ ] 无 primary key 时显示错误, 不允许编辑

#### commitEdit
- [ ] 构建 primaryKeys map (所有 PK 列)
- [ ] 发送 updateRow 消息
- [ ] 编辑后刷新当前页

#### Insert
- [ ] handleInsert() 构建空 row (使用 defaultValue)
- [ ] 发送 insertRow 消息
- [ ] 延迟 200ms 后刷新当前页

#### Delete
- [ ] handleDelete() 构建 primaryKeys 数组
- [ ] 无 primary key 时显示错误
- [ ] 发送 deleteRows 消息
- [ ] 延迟 200ms 后刷新当前页

#### 虚拟化
- [ ] useVirtualizer 正确计算 virtualItems
- [ ] ROW_HEIGHT=32, OVERSCAN=10
- [ ] 滚动时正确渲染可见行

#### NULL 值显示
- [ ] NULL/undefined 显示为 "NULL" (className='null-value')

#### PK 列样式
- [ ] isPrimaryKey 列添加 className='pk-column'

#### 错误处理
- [ ] error 状态显示错误消息
- [ ] 工具栏仍然可用 (refresh, insert, delete)

#### loading 状态
- [ ] rows.length=0 且 loading 时显示 "Loading..."

---

### DataGridToolbar.tsx

#### 渲染
- [ ] 显示 tableName
- [ ] Refresh 按钮调用 onRefresh
- [ ] Insert Row 按钮调用 onInsert
- [ ] Delete Selected 按钮调用 onDelete
- [ ] hasSelection=false 时 Delete 按钮 disabled

---

### DataGridPagination.tsx

#### 页码计算
- [ ] currentPage = floor(offset / limit) + 1
- [ ] totalPages = ceil(total / limit), 最小为 1
- [ ] from = offset + 1
- [ ] to = min(offset + limit, total)

#### 按钮状态
- [ ] First/Prev 在 currentPage=1 时 disabled
- [ ] Next/Last 在 currentPage=totalPages 时 disabled

#### 分页操作
- [ ] First 跳转到 offset=0
- [ ] Prev 跳转到 offset - limit
- [ ] Next 跳转到 offset + limit
- [ ] Last 跳转到 (totalPages - 1) * limit

#### 空数据显示
- [ ] total=0 时显示 "No rows"

---

### ConnectionForm.tsx

#### 表单状态
- [ ] initialState 正确 (name='', driverType='mysql', host='localhost', port='3306', ...)
- [ ] updateField() 更新单个字段
- [ ] updateField() 清空 testResult

#### driverType 切换
- [ ] 切换到 postgresql 时, 如果 port 是旧默认值 (3306), 自动更新为 5432
- [ ] 切换到 mysql 时, 如果 port 是旧默认值 (5432), 自动更新为 3306
- [ ] 手动修改 port 后, 切换 driverType 不覆盖 port

#### Test Connection
- [ ] handleTest() 发送 testConnection 消息
- [ ] testing 状态设为 true
- [ ] 接收 connectionTestResult 消息
- [ ] success=true 显示 "Connection successful!"
- [ ] success=false 显示 "Connection failed: ..."
- [ ] testing 状态设为 false

#### Save Connection
- [ ] handleSave() 发送 saveConnection 消息
- [ ] name 为空时不允许保存 (按钮 disabled)
- [ ] name trim 空格

#### 表单验证
- [ ] name 必填
- [ ] port 为数字 (type="number")
- [ ] password 为 password 类型 (隐藏显示)

---

### QueryEditor.tsx

#### SQL 输入
- [ ] textarea 受控组件, value=sql
- [ ] onChange 更新 sql 状态
- [ ] placeholder="SELECT * FROM ..."
- [ ] spellCheck=false

#### 执行查询
- [ ] executeQuery() trim sql, 为空时不执行
- [ ] 发送 executeQuery 消息
- [ ] executing 状态设为 true
- [ ] 清空 result

#### 快捷键
- [ ] Ctrl/Cmd+Enter 执行查询
- [ ] preventDefault() 阻止默认行为

#### 接收结果
- [ ] 接收 queryResult 消息
- [ ] 设置 result (columns, rows, affectedRows, executionTime, error)
- [ ] executing 状态设为 false

#### 渲染结果
- [ ] result 不为空时渲染 QueryResults 组件

#### 按钮状态
- [ ] executing=true 或 sql 为空时 Execute 按钮 disabled
- [ ] executing=true 时按钮文本为 "Executing..."

---

### QueryResults.tsx

#### 错误显示
- [ ] error 存在时显示错误消息

#### 信息行
- [ ] hasRows=true 时显示 "X rows returned in Yms"
- [ ] hasRows=false 时显示 "X rows affected in Yms"

#### 表格渲染
- [ ] hasRows=true 时渲染 table
- [ ] thead 渲染 columns
- [ ] tbody 渲染 rows
- [ ] NULL 值 className='null-value', 显示 "NULL"

---

### useVSCodeMessage.ts

#### 事件监听
- [ ] 注册 window message 事件监听器
- [ ] 调用 handler(event.data)
- [ ] cleanup 时移除监听器
- [ ] handler 改变时重新注册 (useEffect 依赖)

---

### usePostMessage.ts

#### 消息发送
- [ ] 调用 vscodeApi.postMessage(message)
- [ ] 返回稳定的 callback (useCallback)

---

## 集成测试

### 消息通信
- [ ] Webview 发送 ready -> Extension 响应 viewInit
- [ ] Webview 发送 fetchRows -> Extension 响应 tableData
- [ ] Webview 发送 updateRow -> Extension 执行 update
- [ ] Webview 发送 insertRow -> Extension 执行 insert
- [ ] Webview 发送 deleteRows -> Extension 执行 delete (批量)
- [ ] Webview 发送 executeQuery -> Extension 响应 queryResult
- [ ] Webview 发送 testConnection -> Extension 响应 connectionTestResult
- [ ] Webview 发送 saveConnection -> Extension 保存并刷新 tree
- [ ] Extension 发送 error -> Webview 显示错误

### 端到端流程
- [ ] 添加 MySQL connection -> 测试连接 -> 保存 -> 连接 -> 浏览 databases/tables
- [ ] 添加 PostgreSQL connection -> 测试连接 -> 保存 -> 连接 -> 浏览 databases/tables
- [ ] 打开 table -> 查看数据 -> 编辑单元格 -> 保存 -> 验证数据
- [ ] 打开 table -> 插入新行 -> 验证数据
- [ ] 打开 table -> 删除行 -> 验证数据
- [ ] 打开 query editor -> 执行 SELECT -> 查看结果
- [ ] 打开 query editor -> 执行 INSERT/UPDATE/DELETE -> 查看 affectedRows
- [ ] 分页浏览大表 (1000+ 行)
- [ ] 断开连接 -> tree 节点折叠, 状态更新
- [ ] 删除 connection -> tree 节点移除, credential 删除

---

## 安全测试

### SQL Injection 防护
- [ ] buildSelect/buildCount/buildInsert/buildUpdate/buildDelete 使用参数化查询
- [ ] table/column 名通过 escapeIdentifier 转义
- [ ] 用户输入的 table/column 名包含 SQL 注入攻击字符串 (' OR '1'='1)
- [ ] 用户输入的 data 包含 SQL 注入攻击字符串
- [ ] raw SQL 执行 (executeRaw) - 不做防护, 由用户自行负责

### Credential 安全
- [ ] password 存储到 VSCode SecretStorage (不存储到 globalState)
- [ ] credential-store 使用正确的 key prefix
- [ ] 删除 connection 时同时删除 credential

---

## 边界条件

### 空数据
- [ ] 空 database (0 tables)
- [ ] 空 table (0 rows)
- [ ] 空 row (0 columns) - 不太可能, 但需处理
- [ ] NULL 值 (所有列)

### 大数据
- [ ] 1000+ rows 分页浏览
- [ ] 100+ columns 表 (横向滚动)
- [ ] 长文本字段 (10KB+)
- [ ] BLOB/二进制字段 (显示为 [BLOB] 或 hex)

### 特殊字符
- [ ] table/column 名包含空格, 引号, SQL keywords (SELECT, FROM, etc.)
- [ ] table/column 名包含 Unicode 字符 (中文, emoji)
- [ ] data 包含特殊字符 (换行符, 制表符, NULL 字符)

### 错误恢复
- [ ] 网络中断时重连
- [ ] 数据库重启后重连
- [ ] 查询超时后重试
- [ ] 错误后 UI 状态恢复 (loading=false, error 显示)

---

## 性能测试

### 响应时间
- [ ] fetchRows (100 rows) < 500ms
- [ ] listDatabases < 200ms
- [ ] listTables < 500ms
- [ ] listColumns < 200ms
- [ ] executeQuery (简单 SELECT) < 500ms

### 虚拟化
- [ ] 渲染 10000 rows 时只渲染可见行 (验证 DOM 节点数量)
- [ ] 滚动流畅度 (60fps)

### 内存
- [ ] 长时间使用不泄漏 (10+ 次查询)
- [ ] 大表查询后内存释放

---

## 兼容性测试

### MySQL 版本
- [ ] MySQL 5.7
- [ ] MySQL 8.0
- [ ] MariaDB 10.x

### PostgreSQL 版本
- [ ] PostgreSQL 12
- [ ] PostgreSQL 13
- [ ] PostgreSQL 14+

### VSCode 版本
- [ ] VSCode 1.80+
- [ ] VSCode Insiders

---

## 回归测试

每次修改后运行以下关键流程:

1. [ ] 添加并连接 MySQL connection
2. [ ] 添加并连接 PostgreSQL connection
3. [ ] 浏览 tree (databases -> tables -> columns)
4. [ ] 打开 table, 查看/编辑/插入/删除数据
5. [ ] 打开 query editor, 执行 SELECT/INSERT/UPDATE/DELETE
6. [ ] 断开并删除 connection
