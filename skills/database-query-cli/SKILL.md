---
name: database-query-cli
description: 使用 database-query_cli 列出已配置数据源、查看表结构并执行参数化只读 SQL。涉及 PostgreSQL、MySQL 或 SQLite 的数据库查询、表结构检查和业务数据统计时使用。不用于数据修改、建表或数据库管理。
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
- 远程数据源由用户在交互终端运行 `init` 向导创建，需要 TTY，agent 不得代替执行或模拟键盘输入；SQLite 数据源只需已有文件绝对路径。
- 需要核对数据源指向时，运行 `show --database <别名>`：只显示业务标识（类型、描述、库名）与 TLS 模式，不含主机、端口、用户名。
- 不读取、打印或转述工具保存的密码与数据源配置，不把连接信息写进回复；不要索取用户密码。数据源由用户维护，CLI 自行解析。
- 不将业务数据库或查询结果写入 `ai-rule` 仓库，不把密码放进参数、Skill、日志或回复。
- Skill 是行为约定，不是文件访问控制；只读账户也不保证数据保密。

## 查询流程

1. 执行 `list`，根据公开别名和描述确定数据源。不猜测数据库名；目标不明确时询问用户。
2. 执行 `describe --database <别名>`；已知表名时用 `--table <表名>`，否则用 `--table-like '片段'`（包含匹配，`*`、`%`、`?` 均可作为通配符）。不要无过滤整库 describe：结果被截断时命令返回 `RESULT_TOO_LARGE`，应改用过滤而不是重试。PostgreSQL 可指定 schema；SQLite 不传 schema，MySQL 不跨配置数据库查询。
3. 根据实际结构编写最小必要 SELECT，优先明确列名、筛选条件和较小行数；不默认导出整表或读取密码、令牌等敏感列。
4. SQL 和参数文件保存在当前任务专用目录，使用 UTF-8 无 BOM。业务值使用占位符绑定，不拼接用户输入。PostgreSQL 使用 `$1` 等占位符，MySQL/SQLite 使用 `?`。SQL 内不写注释，白名单会整体拒绝。
5. 调用 `query --database <别名> --sql-file <SQL文件> --max-rows <正整数>`；参数用 `--parameters-file <JSON文件>` 或内联 `--parameters '[1]'`，两者不可同时使用。无参数时两者都省略；参数为字符串、有限数字、布尔值或 null 组成的 JSON 数组。内联参数会留在 shell 历史与进程列表中，敏感业务值仍用文件绑定。
6. SQL 从 stdin 读取时指定 `--sql-file -`；SQL 与参数文件不同时共用 stdin。
7. 检查退出码、`rowCount` 和 `truncated`。结果截断时说明不完整，不把部分结果当作完整统计，也不自动调高限制或无限重试。

成功结果在 stdout，查询结果为含 `columns` 和二维 `rows` 的 JSON；不要按列名转对象而丢失重复列。大整数和精确小数可能以字符串返回，不随意转为浮点数。回复只包含用户所需的最少数据和结论，不额外保存原始结果。

## 失败与安全底线

- 非零退出或 stderr 安全错误码表示失败；只报告错误码及必要上下文，不输出驱动原始异常。
- `CONFIG_ERROR`：请用户检查数据源条目；`NOT_FOUND`：核对公开别名或可见表；`INVALID_REQUEST`：检查 CLI 帮助和参数格式。
- `CREDENTIAL_ERROR`：数据源不可用或未配置；请用户重新运行 `init` 向导，不尝试读取凭据内容。
- `SQL_REJECTED`、`READ_ONLY_REQUIRED`：停止，不绕过白名单、只读事务或账户保护。
- `TIMEOUT`、`RESULT_TOO_LARGE`：缩小查询范围或返回列；整库 describe 被截断时改用 `--table` 或 `--table-like` 过滤，不自动提高安全限额。`DATABASE_ERROR`：报告连接或执行失败，不读取凭证排查。
- 不执行写入、DDL、多语句、事务管理、未知函数或文件输出；不得改用 cli、原生数据库 CLI、驱动脚本或修改程序来绕过限制。
- 单进程并发上限不限制多个 CLI 进程的总并发；不要批量并行启动查询制造数据库负载。
