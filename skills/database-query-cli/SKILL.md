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

`query.sql` 可包含 PostgreSQL 查询 `SELECT id FROM orders WHERE id = $1`，`parameters.json` 内容为 `[123]`。使用文件避免 Shell 展开 `$1`；若用 Bash here-document 写 SQL，引用分隔符（例如 `<<'SQL'`）以禁止变量和命令替换。示例配置路径仍须存在并由用户维护，不创建或覆盖真实配置。

需要 Node.js 24.4 或更新的 24.x。入口缺失时报告需要在工具目录安装依赖并构建，不擅自安装、修改源码或回退到数据库原生客户端。具体参数先查顶层 `--help`，不猜测不存在的选项。

## 配置与凭证

- 每次显式传入 `--config` 的绝对路径。优先使用用户提供的路径；未指定时只检查 `~/.config/database-query/databases.json` 和工具目录的 `config/databases.json` 是否存在，只有一个存在时使用它。两者都存在或都不存在时，请用户指定，不读取内容来猜测。
- 不读取、打印、复制真实配置、`.env` 或凭证；不要索取用户密码。配置由用户维护，CLI 自行加载。
- 不将真实配置、业务数据库或查询结果写入 `ai-rule` 仓库，不把密码放进参数、Skill、日志或回复。
- Skill 是行为约定，不是文件访问控制；只读账户也不保证数据保密。
- 禁止读取databases.json内容

## 查询流程

1. 执行 `list --config <绝对路径>`，根据公开别名和描述确定数据源。不猜测数据库名；目标不明确时询问用户。
2. 执行 `describe --database <别名> --config <绝对路径>`；已知表时增加 `--table`。PostgreSQL 可指定 schema；SQLite 不传 schema，MySQL 不跨配置数据库查询。
3. 根据实际结构编写最小必要 SELECT，优先明确列名、筛选条件和较小行数；不默认导出整表或读取密码、令牌等敏感列。
4. SQL 和参数文件保存在当前任务专用目录，使用 UTF-8 无 BOM。业务值使用占位符绑定，不拼接用户输入。PostgreSQL 使用 `$1` 等占位符，MySQL/SQLite 使用 `?`。
5. 调用 `query --database <别名> --sql-file <SQL文件> --parameters-file <JSON文件> --max-rows <正整数> --config <绝对路径>`。无参数时省略参数文件；参数文件为字符串、有限数字、布尔值或 null 组成的 JSON 数组。
6. SQL 从 stdin 读取且需要参数文件时，指定 `--sql-file -`。参数文件单独传入，不让 SQL 和参数共用 stdin。
7. 检查退出码、`rowCount` 和 `truncated`。结果截断时说明不完整，不把部分结果当作完整统计，也不自动调高限制或无限重试。

成功结果在 stdout，查询结果为含 `columns` 和二维 `rows` 的 JSON；不要按列名转对象而丢失重复列。大整数和精确小数可能以字符串返回，不随意转为浮点数。回复只包含用户所需的最少数据和结论，不额外保存原始结果。

## 失败与安全底线

- 非零退出或 stderr 安全错误码表示失败；只报告错误码及必要上下文，不输出驱动原始异常。
- `CONFIG_ERROR`：请用户检查配置；`NOT_FOUND`：核对公开别名或可见表；`INVALID_REQUEST`：检查 CLI 帮助和参数格式。
- `SQL_REJECTED`、`READ_ONLY_REQUIRED`：停止，不绕过白名单、只读事务或账户保护。
- `TIMEOUT`、`RESULT_TOO_LARGE`：缩小查询范围或返回列；不自动提高安全限额。`DATABASE_ERROR`：报告连接或执行失败，不读取凭证排查。
- 不执行写入、DDL、多语句、事务管理、未知函数或文件输出；不得改用 cli、原生数据库 CLI、驱动脚本或修改程序来绕过限制。
- 单进程并发上限不限制多个 CLI 进程的总并发；不要批量并行启动查询制造数据库负载。
