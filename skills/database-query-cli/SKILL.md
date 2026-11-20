---
name: database-query-cli
description: 查询或统计 PostgreSQL、MySQL、MariaDB 或 SQLite 中的业务数据，查看表结构或索引，列出已配置的数据源，或排查 database-query CLI 的 SQL 拒绝与查询失败时使用。通过 CLI 执行参数化只读查询；不用于写入数据、变更表结构或管理数据库。
---

# database-query_cli

## 入口

工具目录为 `~/ai-rule/tools/database-query-cli/`，编译入口为 `dist/cli.js`。将 `~` 解析为当前用户主目录，使用绝对路径调用，避免依赖当前工作目录。

PowerShell：

```powershell
$tool = Join-Path $HOME 'ai-rule/tools/database-query-cli'
$cli = Join-Path $tool 'dist/cli.js'
node $cli --help
```

Bash（Linux/macOS/WSL）：

```bash
tool="$HOME/ai-rule/tools/database-query-cli"
cli="$tool/dist/cli.js"
node "$cli" --help
```

`query.sql` 可包含 PostgreSQL 查询 `SELECT id FROM orders WHERE id = $1`，`parameters.json` 内容为 `[123]`。使用文件避免 Shell 展开 `$1`；若用 Bash here-document 写 SQL，引用分隔符（例如 `<<'SQL'`）以禁止变量和命令替换。

需要 Node.js 24.4 或更新的 24.x。入口缺失时报告需要在工具目录安装依赖并构建，不擅自安装、修改源码或回退到数据库原生客户端。具体参数先查顶层 `--help`，不猜测不存在的选项。

## 配置与凭证

- 所有命令都不使用路径参数，数据源一律按别名引用。
- 远程数据源由用户在交互终端运行 `init` 向导创建、`edit` 向导修改描述或别名，两者都需要 TTY，agent 不得代替执行或模拟键盘输入；SQLite 数据源只需已有文件绝对路径。
- 需要核对数据源指向时，运行 `show --database <别名>`：只显示业务标识（类型、描述、库名）与 TLS 模式，不含主机、端口、用户名。
- 不读取、打印或转述工具保存的密码与数据源配置，不把连接信息写进回复；不要索取用户密码。数据源由用户维护，CLI 自行解析。
- 不将业务数据库或查询结果写入 `ai-rule` 仓库，不把密码放进参数、Skill、日志或回复。
- Skill 是行为约定，不是文件访问控制；只读账户也不保证数据保密。

## 查询流程

1. 执行 `list`，根据公开别名和描述确定数据源。不猜测数据库名；目标不明确时询问用户。
2. 执行 `describe --database <别名>`；已知表名时用 `--table <表名>`，否则用 `--table-like '片段'`（包含匹配，`*`、`%`、`?` 均可作为通配符）。不要无过滤整库 describe：结果被截断时命令返回 `RESULT_TOO_LARGE`，应改用过滤而不是重试。PostgreSQL 可指定 schema；SQLite 不传 schema，MySQL 不跨配置数据库查询。
3. 根据实际结构编写最小必要 SELECT，优先明确列名、筛选条件和较小行数；不默认导出整表或读取密码、令牌等敏感列。优先使用目标数据库中常见、易读的写法；有等价的常见写法时，不选用少见的方言运算符或专用函数，也不为解决兼容性问题引入更生僻的写法。
4. SQL 和参数文件保存在当前任务专用目录，使用 UTF-8 无 BOM。业务值使用占位符绑定，不拼接用户输入。PostgreSQL 使用 `$1` 等占位符，MySQL/SQLite 使用 `?`。SQL 内不写注释，词法检查会整体拒绝。
5. 调用 `query --database <别名> --sql-file <SQL文件> --max-rows <正整数>`；参数用 `--parameters-file <JSON文件>` 或内联 `--parameters '[1]'`，两者不可同时使用。无参数时两者都省略；参数为字符串、有限数字、布尔值或 null 组成的 JSON 数组。内联参数会留在 shell 历史与进程列表中，敏感业务值仍用文件绑定。
6. SQL 从 stdin 读取时指定 `--sql-file -`；SQL 与参数文件不同时共用 stdin。
7. `list`、`show`、`describe` 和 `query` 的响应是一行 JSON，顶层固定为 `ok` 和 `result`。退出码为 0 时从 stdout 读取 `ok:true` 的响应；退出码为 1 时从 stderr 读取 `ok:false` 的响应。无法解析 JSON 时，报告响应不可读，不根据内容猜测数据库是否执行成功。

成功时从 `result` 读取数据。查询结果包含 `columns` 和二维 `rows`，不要按列名转对象而丢失重复列。检查 `result.rowCount` 和 `result.truncated`；结果截断时说明不完整，不把部分结果当作完整统计，也不自动调高限制或无限重试。大整数和精确小数可能以字符串返回，不随意转为浮点数。回复只包含用户所需的最少数据和结论，不额外保存原始结果。

## MySQL 表结构与索引

需要完整建表定义、索引或表统计信息时，通过 `query` 执行以下单条 SHOW；MySQL 与 MariaDB 均适用，PostgreSQL 和 SQLite 不使用这些语句：

```sql
SHOW [FULL] TABLES [LIKE 'pattern']
SHOW [FULL] {COLUMNS | FIELDS} {FROM | IN} table [LIKE 'pattern']
SHOW {INDEX | INDEXES | KEYS} {FROM | IN} table
SHOW CREATE TABLE table
SHOW TABLE STATUS [LIKE 'pattern']
```

方括号表示可选，`|` 表示关键词选项，不写入实际 SQL。表名用单段标识符或反引号标识符；不写库名前缀或额外的 `FROM db` / `IN db`，即使与当前库同名也不使用。LIKE 仅接受单引号字面量，内部单引号用双单引号转义；不使用 `LIKE ?`、WHERE、函数、变量或其他子句。动态结构过滤使用 `describe --table-like`，不要拼接不可信输入。

例如 `SHOW CREATE TABLE book;` 和 `SHOW INDEX FROM book;` 分别执行，不放进同一次查询。未列出的 SHOW 不执行，尤其是账户、权限、进程、配置、引擎诊断与复制日志类。表定义、默认值和注释仍可能含敏感业务信息，只返回本次任务必要内容。SQL SHOW 与用于查看数据源标识的 CLI `show --database` 不同。

## 失败与安全底线

- `ok:false` 时，使用 `result.code` 和 `result` 中可用的原因、位置或诊断字段判断下一步。用自然语言说明已确认的原因和必要上下文，不输出原始异常。
- `CONFIG_ERROR`：请用户检查数据源条目；`NOT_FOUND`：核对公开别名或可见表；`INVALID_REQUEST`：检查 CLI 帮助和参数格式。
- `CREDENTIAL_ERROR`：数据源不可用或未配置；请用户重新运行 `init` 向导，不尝试读取凭据内容。
- `SQL_REJECTED`：只有 `result.reason` 为 `parse_failed`、能定位不兼容的写法，且有语义等价的常见写法时，才保留数据源、查询限额和参数绑定，通过同一 CLI 自动改写并重试一次，无需人工确认。成功后返回结果并简要说明改写。词法拒绝、策略拒绝、原因不明、无法等价改写或重试仍失败时，停止并报告。CLI 解析失败不代表数据库不支持该语法。
- `READ_ONLY_REQUIRED`：停止并报告，不重试，不绕过只读事务或账户保护。
- `TIMEOUT`、`RESULT_TOO_LARGE`：缩小查询范围或返回列；整库 describe 被截断时改用 `--table` 或 `--table-like` 过滤，不自动提高安全限额。`DATABASE_ERROR`：报告连接或执行失败，不读取凭证排查。
- 不执行写入、DDL、多语句、事务管理、文件输出或危险函数（文件读取、休眠、加锁类）；不得改用 cli、原生数据库 CLI、驱动脚本或修改程序来绕过限制。
- 单进程并发上限不限制多个 CLI 进程的总并发；不要批量并行启动查询制造数据库负载。
