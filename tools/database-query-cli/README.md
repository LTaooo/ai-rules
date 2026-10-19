# database-query_cli

TypeScript 数据库只读查询工具，同时支持多个命名的 PostgreSQL、MySQL 和 SQLite 数据源。CLI 供人工、脚本、Claude Code 和 Codex 共用。

代码当前位于 `~/ai-rule/tools/database-query-cli/`。统一 Skill 位于 `~/ai-rule/skills/database-query-cli/SKILL.md`，只维护调用流程，不复制源码或凭证。

## CLI 快速开始

需要 Node.js 24.4 或更新的 24.x 版本。在本工具目录执行 `npm ci` 和 `npm run build`，生成 `dist/cli.js`。

PowerShell 中从任意工作目录调用：

```powershell
$cli = Join-Path $HOME 'ai-rule/tools/database-query-cli/dist/cli.js'

node $cli --help
node $cli init
node $cli list
node $cli describe --database local --table orders
node $cli query --database local --sql-file ./query.sql --parameters-file ./parameters.json --max-rows 100
```

最后一条命令的文件示例仅使用虚构值：`query.sql` 内容为 `SELECT id FROM orders WHERE id = ?`，`parameters.json` 内容为 `[123]`。文件由调用者在本次任务目录中准备，使用 UTF-8 无 BOM 编码，不提交查询数据或敏感参数。

SQL 默认从标准输入读取；参数化查询使用 `--sql-file`，若 SQL 来自标准输入则显式指定 `--sql-file -`，参数 JSON 使用独立文件，不同时从 stdin 读取两份输入。当前没有 `--sql`、`--format` 或 CSV 输出选项；具体参数通过顶层 `--help` 查询。

- `list` 返回数据库别名、类型和公开描述；`show --database <别名>` 只返回业务标识（类型、描述、库名）与 TLS 模式，不返回主机、端口、用户名或密码——主机与用户名属于侦察信息，完整接线由用户通过 `cmdkey /list:database-query.<别名>` 查看。
- `describe` 返回可见列信息，支持精确 `--table` 或模糊 `--table-like`（`%` 通配）；无过滤且结果被截断时返回 `RESULT_TOO_LARGE`，应改用过滤。`query` 返回 `columns`、`rows`、`rowCount`、`truncated`、`durationMs`。
- CLI 成功结果为 stdout JSON；帮助为文本。常规失败在 stderr 输出安全错误码，退出码为 1，成功为 0。CLI 关闭请求日志。
- 显式增加 `--diagnose` 时，MySQL 失败会额外在 stderr 输出固定执行阶段和白名单错误码；不输出驱动原始消息、连接地址、凭证、SQL 或参数。`CONNECT` 表示连接尚未建立，`UNKNOWN` 表示错误码不在公开白名单内，不能据此推断具体原因。
- CLI 复用 `QueryService`、`SqlPolicy` 和数据库适配器，不通过 Skill 绕过只读保护。每次命令独立启动，并发限制不是跨 CLI 进程的全局限制。
- 全部数据源配置（含密码）保存在 Windows 凭据管理器：每个数据源一条通用凭据，目标名为 `database-query.<别名>`，内容为整份 JSON 配置。没有任何配置文件；不接入云凭据管理，不使用 `.agentsignore`。
- `init` 子命令运行交互式向导：询问数据源信息与密码（密码提示不回显），经 PowerShell `CredWriteW` 写入凭据管理器并读回验证。向导需要交互终端，由用户自行运行；命令不再接受任何路径参数。

CLI 目前是新增实现；使用前执行 `npm run check`，并用独立 SQLite 测试配置验证 CLI，不能用生产配置做冒烟测试。

## 能力与边界

- 子命令覆盖数据源列表、结构查询与只读业务查询，详见快速开始与 `--help`。
- 通用 SQL 仅接受单条 SELECT、纯查询 WITH 和 UNION 等经过正向许可验证的语法。
- 拒绝写入、删除、DDL、事务管理、多语句、注释、锁定查询、递归 CTE（WITH RECURSIVE）、输出文件和未知函数。
- 使用 AST 递归校验、数据库只读保护和最小权限账户；不能识别的 SQL 不降级放行。
- 默认最多返回 1000 行、10 秒执行时间、1 MiB 响应，每个数据源最多 4 个并发请求。
- 数据源描述、地址、用户名和凭据目标名保存于凭据条目；远程数据库密码只存 Windows 凭据管理器，JSON 不含明文密码。不接入云凭据管理，不使用 `.agentsignore`。
- 运行日志使用 JSON Lines 写入 stderr，记录启动、停止、请求状态、耗时、行数、截断标识和安全错误码；不记录 SQL、参数、连接串、凭证或查询数据。

只读不等于数据保密。账户只能查询允许 agent 看到的业务表或视图；不要授权保存密码、访问令牌或其他敏感数据的表。数据库扩展、视图、自定义类型和对象定义由可信管理员维护。服务不承诺恶意数据库扩展没有外部副作用。

## 环境与安装

使用 Node.js 24.4 或更新的 24.x 版本、npm、Git。当前本地验证环境为 Windows、Node.js 24.20.0。

在项目目录执行：

```powershell
npm ci
npm run build
node dist/cli.js init
```

向导依次询问数据源信息，密码通过不回显的提示输入：整份配置（含密码）作为一条凭据写入 Windows 凭据管理器，不产生任何配置文件。明文只在工具内存中短暂存在（查询阶段同样如此），不落盘、不进日志、不进命令行。删除某个数据源用 `cmdkey /delete:database-query.<别名>`；修改后重新运行 `init`，同名条目确认替换。`AGENTS.md` 是行为约定，不是文件访问控制：能够使用终端或修改服务代码的 agent 仍可能在运行时取得凭证。

## 数据源与凭据

每个数据源对应凭据管理器中的一条通用凭据，目标名为 `database-query.<别名>`，内容为该数据源的整份 JSON 配置（含远程密码）。虚构示例：

```json
{
    "name": "sales",
    "type": "postgres",
    "description": "Sales query source",
    "host": "sales-db.internal",
    "port": 5432,
    "database": "sales",
    "username": "fictional_reader",
    "password": "replace_with_real_password",
    "sslMode": "verify-full"
}
```

- 每个数据源必填 `name`、`type`、`description`；别名唯一，允许字母、数字、下划线和连字符，最多 128 字符。条目数量上限 64。
- 远程数据库必填 `host`、`database`、`username`、`password`，端口必须是 1–65535 的整数，缺省为 PostgreSQL 5432、MySQL 3306。密码长度 1–1024。不使用 URL。
- SQLite 必须使用绝对 `filename`，不允许 `:memory:`；SQLite 条目没有密码字段，文件缺失在查询时报数据库错误。
- PostgreSQL `sslMode` 为 `disable`、`require` 或 `verify-full`，默认 `require`（加密但不验证证书）；远程连接建议 `verify-full` 并配置信任链。
- MySQL 支持 5.6.5+ 的 5.6、5.7 和 8.x；每次连接通过内部版本查询选择超时策略。仅接受数字版本及 `-log`、`-community`、`-community-log` 后缀；MariaDB、未知厂商后缀、其他版本系列和非法版本在业务查询前拒绝。`tls` 只接受布尔值，默认 false，true 时验证服务器证书。未知字段一律拒绝，不能开启多语句。
- MySQL 5.6 和 5.7.0–5.7.7 仅有客户端超时及强制断连，没有服务端执行时限；关闭本地 Socket 不保证服务端查询立即停止。5.7.8+ 和 8.x 保留 `MAX_EXECUTION_TIME`。旧版本已停止维护，建议升级，并由管理员配置独立资源约束。SQL 不自动改写为旧版方言。
- 描述是公开信息，不要在描述、别名中写入密码、连接串或私密地址。
- 行数硬上限 1000（可调至 10000）、超时 10 秒（至 60000 毫秒）、响应 1 MiB（至 10 MiB）、并发每数据源 4（至 16）为内置默认，当前版本不接受外部覆盖。

## 查询语义

### 结构查询

`describe --database sales --schema public --table orders`，模糊过滤用 `--table-like 'order%'`。

`table` 精确匹配；`tableLike` 模糊过滤——不含 `%` 时按包含匹配（`*`、`?` 自动转译为通配符），含 `%` 时按 SQL LIKE 原样使用。两者互斥；无过滤且结果被截断时返回 `RESULT_TOO_LARGE`。返回统一的列信息查询结果，列包括 `schema_name`、`table_name`、`table_type`、`column_name`、`data_type`、`nullable`、`primary_key`。可不填 table，查询可见结构；PostgreSQL 默认 public。SQLite 不接受 schema，MySQL 的 schema 只能是当前配置数据库。

### 业务查询

`query --database sales --sql-file ./query.sql --parameters-file ./parameters.json --max-rows 100`。

PostgreSQL 使用 `$1`、`$2` 等占位符，MySQL 和 SQLite 使用 `?`。参数类型为字符串、有限数字、布尔值或 null。`--max-rows` 不能超过全局行数上限；`--parameters-file` 与 `--parameters` 不可同时使用。

结果包含 `columns`、二维数组 `rows`、`rowCount`、`truncated`、`durationMs`。数组保留重复列名；大整数和精确小数以字符串返回；SQLite 整数统一为字符串。二进制输出为 `{ "type": "binary", "base64": "..." }`。PostgreSQL 驱动 Date 输出 ISO 字符串；MySQL 日期保留数据库返回的文本；不自动给无时区文本补时区。

函数许可按方言区分：COUNT、SUM、AVG、MIN、MAX、COALESCE、NULLIF、LOWER、UPPER、LENGTH、ABS、ROUND、TRIM、LTRIM、RTRIM、SUBSTR、SUBSTRING、CONCAT 三种方言通用；CHAR_LENGTH 仅 MySQL 与 PostgreSQL，DATE_FORMAT 仅 MySQL。EXISTS 与 NOT EXISTS 的参数必须是子查询，经同一白名单递归校验后放行。其余函数、窗口函数、用户定义函数，以及限定 schema 或带引号的函数一律拒绝，不自动改写方言。CAST 只允许内置类型。拒绝注释、反斜杠转义、PostgreSQL dollar-quoted 字符串和 WITH RECURSIVE；字符串里普通的 DELETE 等关键字不会被误判。

行数只省略完整行，超大字段返回错误而非截断字段。限额以规范化结果的字节数计。限额不能替代数据库自身内存、CPU、网络和可见数据范围控制。

## 只读执行

- PostgreSQL：每次请求独立连接，READ ONLY 事务、服务端 statement_timeout、受限 search_path、游标读取最多上限加一行；验证事务只读且拒绝超级用户及常见高权限角色。结束回滚并关闭连接。
- MySQL：每次请求独立连接，READ ONLY 事务、服务器 MAX_EXECUTION_TIME、预处理参数绑定、流式读取。达到上限或超时强制销毁底层 Socket，等待传输关闭后移除追踪；没有读满上限时显式回滚。断连与数据库自身执行时限共同限制后台执行。
- SQLite：只读打开、query_only、禁止扩展加载。每次查询在不继承服务凭证环境的独立子进程执行；超时强制结束进程并等待退出，不阻塞调用方主线程。

管理员必须提供专用最小权限账户，不能使用对象拥有者或数据库管理员账户。程序检查不能证明全部间接角色、视图和扩展安全。`docs/database-permissions.md` 描述账户设置要求。

## 错误

只返回安全错误码，不返回驱动原始消息或堆栈：

| 错误码             | 含义                                 |
| ------------------ | ------------------------------------ |
| CONFIG_ERROR       | 数据源凭据内容缺失或不合法           |
| CREDENTIAL_ERROR   | 凭据缺失、不可读或写入失败           |
| INVALID_REQUEST    | 输入或限额不合法                     |
| SQL_REJECTED       | SQL 不在只读许可范围内               |
| NOT_FOUND          | 数据源或指定表不可见或不存在         |
| READ_ONLY_REQUIRED | 只读保护无法建立或账户权限过高       |
| DATABASE_ERROR     | 连接、认证或执行失败，详细信息被隐藏 |
| TIMEOUT            | 超过执行时间                         |
| RESULT_TOO_LARGE   | 响应或字段过大                       |
| BUSY               | 数据源并发达到上限，稍后重试         |
| CLOSED             | 服务正在关闭或已关闭                 |

## 提交检查与 CI

提交钩子位于仓库根 `.githooks/pre-commit`，由 `core.hooksPath` 启用：暂存改动触及 `tools/database-query-cli/` 时，先在本项目内运行 lint-staged（暂存文件 Prettier 与 ESLint，保留部分暂存恢复）再运行 TypeScript 类型检查；仅改动仓库根级规则与文档时直接放行。开发环境执行 `npm ci` 或 `npm run prepare` 自动启用；`HUSKY=0`、生产环境或省略开发依赖时跳过；`--no-verify` 可临时绕过。

CI 配置位于仓库根 `.github/workflows/ci.yml`，push 与 pull request 触发，在 Windows 与 Linux 双平台于本项目内执行 `npm ci` 与 `npm run check`，作为钩子的远程兜底。

```powershell
npm run format
npm run check
```

check 执行格式检查、ESLint、源码和测试类型检查、编译和测试。没有自动提交、创建分支或连接生产数据库。

## 测试状态与外部集成

默认测试使用真实 SQLite 临时文件与隔离临时 Git 仓库；所有临时文件在 `.test-artifacts` 内。Git 钩子测试不创建提交。

PostgreSQL、MySQL 的连接策略、超时和清理用伪驱动验证；额外使用真实 mysql2 驱动和本机假协议端点验证底层 Socket 在超时和退出时确实销毁。凭据读写用注入的伪子进程验证协议、超时与错误映射，不触碰真实凭据管理器。CLI 的测试组合根支持仅限测试的环境变量 `DATABASE_QUERY_TEST_SOURCES`（JSON 数组，只放合成 SQLite 数据源）；`npm test` 和 `npm run check` 在独立子进程中清除该变量，默认检查从不读取真实凭据或任何配置文件。结构测试使用 TypeScript AST 约束源码类组织、每个命名方法与每个枚举成员的中文 JSDoc。

## 迁移清理状态

JSON 与分类源码迁移已接通。旧源码备份、旧测试备份、迁移辅助脚本和旧 `.env.example` 已清理；`dist` 从当前分类源码重新构建，不包含历史编译模块。正式部署仅发布当前源码构建的产物，不包含测试临时文件或真实凭证。

存储迁移后不再存在任何配置文件：数据源（含密码）整体保存在 Windows 凭据管理器。旧 `databases.json`、`.env` 一律不被读取；对每个数据源重新运行 `init`，同名条目确认替换即可完成迁移，工具不自动改写用户数据。

## 文件结构

```text
database-query-cli/
├── src/
│   ├── cli.ts
│   ├── domain/enums/、models/、ports/
│   ├── application/QueryService.ts
│   ├── security/SqlPolicy.ts
│   ├── infrastructure/config/、credentials/、logging/、database/
│   │   └── database/postgres/、mysql/、sqlite/（含隔离 worker）
│   ├── presentation/cli/DatabaseCli.ts、cli/InitWizard.ts
│   └── shared/errors/、results/
├── tests/unit/、integration/
├── scripts/install-hooks.mjs / run-tests.mjs
├── .husky/pre-commit
├── .github/workflows/ci.yml
├── .gitignore / AGENTS.md
├── package.json / package-lock.json
├── docs/database-permissions.md
├── docs/superpowers/specs/ 与 plans/
└── dist/（本地构建生成，不提交）
```
