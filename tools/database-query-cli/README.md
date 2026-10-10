# database-query_cli

TypeScript 数据库只读查询工具，同时支持多个命名的 PostgreSQL、MySQL 和 SQLite 数据源。CLI 供人工、脚本、Claude Code 和 Codex 共用；现有 MCP 入口仍保留。

代码当前位于 `~/ai-rule/tools/database-query-mcp/`，目录尚未更名。统一 Skill 位于 `~/ai-rule/skills/database-query-cli/SKILL.md`，只维护调用流程，不复制源码或凭证。

## CLI 快速开始

需要 Node.js 24.4 或更新的 24.x 版本。在本工具目录执行 `npm ci` 和 `npm run build`，生成 `dist/cli.js`。不要假定迁移前的 `dist` 已包含 CLI。

PowerShell 中从任意工作目录调用：

```powershell
$tool = Join-Path $HOME 'ai-rule/tools/database-query-mcp'
$cli = Join-Path $tool 'dist/cli.js'
# 指定由用户维护的真实配置路径；不要读取或打印配置内容。
$config = Join-Path $HOME '.config/database-query/databases.json'

node $cli --help
node $cli list --config $config
node $cli describe --database local --table orders --config $config
node $cli query --database local --sql-file ./query.sql --parameters-file ./parameters.json --max-rows 100 --config $config
```

最后一条命令的文件示例仅使用虚构值：`query.sql` 内容为 `SELECT id FROM orders WHERE id = ?`，`parameters.json` 内容为 `[123]`。文件由调用者在本次任务目录中准备，使用 UTF-8 无 BOM 编码，不提交查询数据或敏感参数。

SQL 默认从标准输入读取；参数化查询使用 `--sql-file`，若 SQL 来自标准输入则显式指定 `--sql-file -`，参数 JSON 使用独立文件，不同时从 stdin 读取两份输入。当前没有 `--sql`、`--format` 或 CSV 输出选项；具体参数通过顶层 `--help` 查询。

- `list` 返回数据库别名、类型和公开描述。
- `describe` 返回可见列信息；`query` 返回 `columns`、`rows`、`rowCount`、`truncated`、`durationMs`。
- CLI 成功结果为 stdout JSON；帮助为文本。常规失败在 stderr 输出安全错误码，退出码为 1，成功为 0。CLI 当前关闭请求日志，MCP 日志行为见下文。
- 显式增加 `--diagnose` 时，MySQL 失败会额外在 stderr 输出固定执行阶段和白名单错误码；不输出驱动原始消息、连接地址、凭证、SQL 或参数。`CONNECT` 表示连接尚未建立，`UNKNOWN` 表示错误码不在公开白名单内，不能据此推断具体原因。
- CLI 复用 `QueryService`、`SqlPolicy` 和数据库适配器，不通过 Skill 绕过只读保护。每次命令独立启动，并发限制不是跨 CLI 进程的全局限制。
- 真实 JSON 配置建议放在仓库之外，通过 `--config` 指定；省略时仍读取当前工作目录的 `config/databases.json`。不要把明文凭证纳入 `ai-rule` Git 仓库。

CLI 目前是新增实现；迁移前 SQLite/MCP 测试通过不代表迁移后的 CLI 已通过验证。使用前执行 `npm run check`，并用独立 SQLite 测试配置验证 CLI，不能用生产配置做冒烟测试。

## 能力与边界

- 提供 `list_databases`、`describe_schema`、`query_database` 三个 MCP 工具。
- 通用 SQL 仅接受单条 SELECT、纯查询 WITH 和 UNION 等经过正向许可验证的语法。
- 拒绝写入、删除、DDL、事务管理、多语句、注释、锁定查询、输出文件和未知函数。
- 使用 AST 递归校验、数据库只读保护和最小权限账户；不能识别的 SQL 不降级放行。
- 默认最多返回 1000 行、10 秒执行时间、1 MiB MCP 响应，每个数据源最多 4 个并发请求。
- 数据源、描述、用户名和密码全部保存于 JSON；不加载 `.env` 或数据库环境变量，不接入云凭据管理，不使用 `.agentsignore`。
- 运行日志使用 JSON Lines 写入 stderr，记录启动、停止、请求状态、耗时、行数、截断标识和安全错误码；不记录 SQL、参数、连接串、凭证或查询数据。

只读不等于数据保密。账户只能查询允许 agent 看到的业务表或视图；不要授权保存密码、访问令牌或其他敏感数据的表。数据库扩展、视图、自定义类型和对象定义由可信管理员维护。服务不承诺恶意数据库扩展没有外部副作用。

## 环境与安装

使用 Node.js 24.4 或更新的 24.x 版本、npm、Git。当前本地验证环境为 Windows、Node.js 24.20.0。

在项目目录执行：

```powershell
npm ci
npm run build
Copy-Item config/databases.example.json config/databases.json
```

由用户手动编辑 `config/databases.json` 中的真实连接信息。JSON 中密码是明文，必须用操作系统文件权限限制到服务账户，并保护备份、编辑器历史和部署产物。默认真实配置已被 Git 忽略；自定义路径的真实配置也必须加入忽略规则。不要把其内容粘贴给 agent、提交到 Git 或写入日志。配置文件不提供强隔离：能够读取同一账户文件、使用终端或修改服务代码的 agent 仍可能取得凭证。`AGENTS.md` 是行为约定，不是文件访问控制。旧 `.env` 配置不再支持，也不会自动迁移或读取。

## 配置

下面只有虚构凭证：

```json
{
    "limits": {
        "maxRows": 1000,
        "timeoutMs": 10000,
        "maxResponseBytes": 1048576,
        "maxConcurrency": 4
    },
    "databases": [
        {
            "name": "sales",
            "type": "postgres",
            "description": "Sales query source",
            "host": "localhost",
            "port": 5432,
            "database": "sales",
            "username": "fictional_reader",
            "password": "replace_me",
            "sslMode": "verify-full"
        },
        {
            "name": "analytics",
            "type": "mysql",
            "description": "Analytics query source",
            "host": "localhost",
            "port": 3306,
            "database": "analytics",
            "username": "fictional_reader",
            "password": "replace_me",
            "tls": true
        },
        {
            "name": "local",
            "type": "sqlite",
            "description": "Local read-only source",
            "filename": "D:/data/existing.sqlite"
        }
    ]
}
```

- 默认读取工作目录下 `config/databases.json`。可用 `npm start -- --config ./config/databases.json` 或 `node dist/index.js --config <path>` 指定；相对路径基于工作目录。
- 顶层只接受 `limits`、`databases`。每个数据源必填 `name`、`type`、`description`；别名唯一，允许字母、数字、下划线和连字符，最多 128 字符；允许 1–64 个数据源，同类型可有多个实例。
- 远程数据库必填 `host`、`database`、`username`、`password`，端口必须是 1–65535 的整数，缺省为 PostgreSQL 5432、MySQL 3306。不使用 URL，密码中的特殊字符直接按 JSON 字符串转义，不做 URL 编码。
- SQLite 必须使用已有普通文件的绝对 `filename`，Linux 示例为 `/srv/data/existing.sqlite`。不允许 `:memory:`，不会创建缺失文件。
- PostgreSQL `sslMode` 为 `disable`、`require` 或 `verify-full`，默认 `require`（加密但不验证证书）；远程连接建议 `verify-full` 并配置信任链。
- MySQL 支持 5.6.5+ 的 5.6、5.7 和 8.x；每次连接通过内部版本查询选择超时策略。仅接受数字版本及 `-log`、`-community`、`-community-log` 后缀；MariaDB、未知厂商后缀、其他版本系列和非法版本在业务查询前拒绝。`tls` 只接受布尔值，默认 false，true 时验证服务器证书。未知字段、旧 URL 和环境凭证引用全部拒绝，不能开启多语句。
- MySQL 5.6 和 5.7.0–5.7.7 仅有客户端超时及强制断连，没有服务端执行时限；关闭本地 Socket 不保证服务端查询立即停止。5.7.8+ 和 8.x 保留 `MAX_EXECUTION_TIME`。旧版本已停止维护，建议升级，并由管理员配置独立资源约束。SQL 不自动改写为旧版方言。
- 描述是公开信息，不要在描述、别名中写入密码、连接串或私密地址。
- 行数硬上限为 10000，超时硬上限为 60000 毫秒，响应硬上限为 10 MiB，并发硬上限为每数据源 16；配置必须为正整数。

## 运行与 MCP 客户端

从项目目录执行 `npm start`。服务的 stdout 只承载 MCP JSON-RPC 协议，没有普通日志；使用 MCP 客户端调用它，而不是在终端等待普通页面。

日志示例：

```text
{"timestamp":"2026-10-09T00:00:00.000Z","level":"info","event":"query.completed","requestId":"...","database":"sales","durationMs":12,"returnedRows":3,"truncated":false}
```

日志中的数据源别名来自配置，查询内容和参数不会写入日志。错误日志只使用 `ErrorCode`，不输出数据库驱动原始异常。

若客户端不设置工作目录，使用显式绝对配置路径启动：

```json
{
    "mcpServers": {
        "database-query": {
            "command": "node",
            "args": [
                "C:/Users/<用户名>/ai-rule/tools/database-query-mcp/dist/index.js",
                "--config",
                "C:/Users/<用户名>/.config/database-query/databases.json"
            ]
        }
    }
}
```

将路径替换为实际部署目录。配置只出现文件路径，不包含数据库密码，但客户端自身仍可能具有读取该文件的权限。服务不开放读取凭证、文件或环境变量的工具。

## 工具

### `list_databases`

输入 `{}`，返回数据源别名、类型和公开描述，不返回连接地址、文件路径、用户名或密码。

### `describe_schema`

```json
{ "database": "sales", "schema": "public", "table": "orders" }
```

返回统一的列信息查询结果，列包括 `schema_name`、`table_name`、`table_type`、`column_name`、`data_type`、`nullable`、`primary_key`。可不填 table，查询可见结构；PostgreSQL 默认 public。SQLite 不接受 schema，MySQL 的 schema 只能是当前配置数据库。

### `query_database`

```json
{
    "database": "sales",
    "sql": "SELECT id, status FROM orders WHERE id = $1 ORDER BY id",
    "parameters": [123],
    "maxRows": 100
}
```

PostgreSQL 使用 `$1`、`$2` 等占位符，MySQL 和 SQLite 使用 `?`。参数类型为字符串、有限数字、布尔值或 null。客户端 maxRows 不能超过全局限制。

结果包含 `columns`、二维数组 `rows`、`rowCount`、`truncated`、`durationMs`。数组保留重复列名；大整数和精确小数以字符串返回；SQLite 整数统一为字符串。二进制输出为 `{ "type": "binary", "base64": "..." }`。PostgreSQL 驱动 Date 输出 ISO 字符串；MySQL 日期保留数据库返回的文本；不自动给无时区文本补时区。

通用函数许可包含 COUNT、SUM、AVG、MIN、MAX、COALESCE、NULLIF、LOWER、UPPER、LENGTH、CHAR_LENGTH、ABS、ROUND、TRIM、LTRIM、RTRIM、SUBSTR、SUBSTRING、CONCAT；CAST 只允许内置类型。具体数据库不支持的函数会返回数据库错误，不自动改写方言。拒绝限定 schema 或以引号混淆的函数、窗口函数、用户定义函数、注释、反斜杠转义和 PostgreSQL dollar-quoted 字符串。字符串里普通的 DELETE 等关键字不会被误判。

行数只省略完整行，超大字段返回错误而非截断字段。响应限额包含 MCP 中文本和结构化结果两种表示，因此实际能返回的数据量小于设置字节数。限额不能替代数据库自身内存、CPU、网络和可见数据范围控制。

## 只读执行

- PostgreSQL：每次请求独立连接，READ ONLY 事务、服务端 statement_timeout、受限 search_path、游标读取最多上限加一行；验证事务只读且拒绝超级用户及常见高权限角色。结束回滚并关闭连接。
- MySQL：每次请求独立连接，READ ONLY 事务、服务器 MAX_EXECUTION_TIME、预处理参数绑定、流式读取。达到上限或超时强制销毁底层 Socket，等待传输关闭后移除追踪；没有读满上限时显式回滚。断连与数据库自身执行时限共同限制后台执行。
- SQLite：只读打开、query_only、禁止扩展加载。每次查询在不继承服务凭证环境的独立子进程执行；超时强制结束进程并等待退出，不阻塞 MCP 主线程。

管理员必须提供专用最小权限账户，不能使用对象拥有者或数据库管理员账户。程序检查不能证明全部间接角色、视图和扩展安全。`docs/database-permissions.md` 描述账户设置要求。

## 错误

只返回安全错误码，不返回驱动原始消息或堆栈：

| 错误码             | 含义                                 |
| ------------------ | ------------------------------------ |
| CONFIG_ERROR       | 缺失或不合法的配置                   |
| INVALID_REQUEST    | 输入或限额不合法                     |
| SQL_REJECTED       | SQL 不在只读许可范围内               |
| NOT_FOUND          | 数据源或指定表不可见或不存在         |
| READ_ONLY_REQUIRED | 只读保护无法建立或账户权限过高       |
| DATABASE_ERROR     | 连接、认证或执行失败，详细信息被隐藏 |
| TIMEOUT            | 超过执行时间                         |
| RESULT_TOO_LARGE   | 响应或字段过大                       |
| BUSY               | 数据源并发达到上限，稍后重试         |
| CLOSED             | 服务正在关闭或已关闭                 |

## 每次提交自动检查

Husky pre-commit 先对暂存文件执行 Prettier 和 ESLint，再对整个工作区执行 TypeScript 类型检查。任一步失败均拒绝正常提交。lint-staged 保留部分暂存文件的未暂存修改，不会 git add 整个项目。

开发环境可通过 `npm run prepare` 安装本地 Git 钩子；此命令不创建提交。

以后普通开发环境的 `npm ci` 自动安装钩子。生产环境、忽略开发依赖或 `HUSKY=0` 时跳过钩子安装，避免要求生产服务安装 Husky。`HUSKY=0` 或 `--no-verify` 可绕过本地钩子；远程仓库应设置 CI 为合并必需检查。包含 GitHub Actions 的 Windows、Linux 检查配置，但尚未在远程平台运行。

```powershell
npm run format
npm run check
```

check 执行格式检查、ESLint、源码和测试类型检查、编译和测试。没有自动提交、创建分支或连接生产数据库。

## 测试状态与外部集成

默认测试使用真实 SQLite 临时文件、真实 stdio MCP 客户端及隔离临时 Git 仓库；所有临时文件在 `.test-artifacts` 内。Git 钩子测试不创建提交。

PostgreSQL、MySQL 的连接策略、超时和清理用伪驱动验证；额外使用真实 mysql2 驱动和本机假协议端点验证底层 Socket 在超时和退出时确实销毁。`npm test` 和 `npm run check` 在独立子进程中清除旧远端测试 URL 变量与 `MCP_TEST_DATABASE_CONFIG`，始终跳过真实远端数据库集成。必须单独授权并准备独立测试实例和专用只读账户后，才能通过直接运行 Vitest 并提供 `MCP_TEST_DATABASE_CONFIG` 的隔离 JSON 路径启用外部测试；不能使用生产配置。默认检查从不读取业务 `.env` 或真实 JSON。结构测试使用 TypeScript AST 约束源码类组织与每个命名方法的中文 JSDoc。

## 迁移清理状态

JSON 与分类源码迁移已接通。旧源码备份、旧测试备份、迁移辅助脚本和旧 `.env.example` 已清理；`dist` 已删除后从当前分类源码重新构建，不再包含历史编译模块。当前配置示例为 `config/databases.example.json`。正式部署仅发布当前源码构建的产物，不包含测试临时文件或真实凭证配置。

## 文件结构

```text
database-query-mcp/
├── src/
│   ├── index.ts / bootstrap/Application.ts
│   ├── domain/enums/、models/、ports/
│   ├── application/QueryService.ts
│   ├── security/SqlPolicy.ts
│   ├── infrastructure/config/、logging/、database/
│   │   └── database/postgres/、mysql/、sqlite/（含隔离 worker）
│   ├── presentation/mcp/DatabaseMcpServer.ts
│   └── shared/errors/、results/
├── tests/unit/、integration/、helpers/
├── config/databases.example.json
├── scripts/install-hooks.mjs / run-tests.mjs
├── .husky/pre-commit
├── .github/workflows/ci.yml
├── .gitignore / AGENTS.md
├── package.json / package-lock.json
├── docs/database-permissions.md
├── docs/superpowers/specs/ 与 plans/
└── dist/（本地构建生成，不提交）
```
