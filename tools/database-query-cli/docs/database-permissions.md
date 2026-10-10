# 数据库最小权限部署

所有账户、权限和业务视图由数据库管理员在可信部署环境设置。MCP 工具不执行下面的账户管理语句，也不自动创建账户。示例密码都是虚构值，不在 agent 会话或日志中使用真实密码执行这些示例。

## PostgreSQL

提供专用 LOGIN 角色，不得具有 SUPERUSER、CREATEDB、CREATEROLE、REPLICATION，不得通过继承角色得到这些权限；不得拥有查询对象。仅授予连接、所需 schema 的 USAGE，以及明确批准的业务表或视图的 SELECT。

示例假设数据库为 sales，管理员已建立 public.order_query_view：

```sql
CREATE ROLE mcp_reader LOGIN PASSWORD 'replace_me' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE sales TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON public.order_query_view TO mcp_reader;
ALTER ROLE mcp_reader SET default_transaction_read_only = on;
```

服务额外使用 READ ONLY 事务和 statement_timeout，不依赖账户默认设置。程序验证当前角色常见高权限标志，不会穷举所有继承权限和对象定义；管理员仍需审查角色成员、对象拥有者、函数、扩展及视图暴露范围。

不要授予任意 schema 的全部对象权限，也不要让查询账户能够覆盖内置函数、安装扩展、执行具有副作用的自定义函数或访问敏感认证表。具有特权定义者权限的视图也必须经过数据范围审查。

## MySQL

支持 MySQL 5.6.5+ 的 5.6、5.7 和 8.x，所有受支持版本必须成功建立 READ ONLY 事务。5.7.8+ 与 8.x 还必须成功设置 MAX_EXECUTION_TIME；旧版本仅使用客户端截止时间与强制断连。版本检测失败或不支持的版本拒绝执行业务查询，不通过忽略初始化错误自动降级。不要用 root；MariaDB 不在支持范围内。旧版 MySQL 已停止维护，建议升级。

假设数据库为 sales，已建立 order_query_view：

```sql
CREATE USER 'mcp_reader'@'trusted-service-host' IDENTIFIED BY 'replace_me';
GRANT SELECT ON sales.order_query_view TO 'mcp_reader'@'trusted-service-host';
```

将 trusted-service-host 替换为受控服务来源，不默认允许任意来源。不能授予 FILE、EXECUTE、CREATE TEMPORARY TABLES、写入、DDL、管理权限或高权限角色。仅允许查询批准对象；不能授予保存业务密钥的表。

服务关闭多语句，使用预处理参数绑定、只读事务和流式结果，在支持的版本设置服务器 SELECT 执行时限。达行数上限、超时或错误时强制关闭独立连接及底层 Socket，并等待本地传输关闭。MySQL 5.6 与 5.7.8 之前的版本没有服务器执行时限：客户端断连不能保证服务端执行在配置截止时间内停止，不能替代数据库资源控制。生产部署必须设置独立数据库资源约束及网络访问范围。

## SQLite

由用户提供现有本地数据库文件，服务不会创建文件，不使用可写内存数据库。服务以只读方式打开并启用 query_only，禁用扩展加载。

SQLite 没有与远端数据库相同的表级用户授权机制。如果文件含有敏感表，不要将整个文件交给 agent 查询，应准备只包含允许数据的专用文件。数据库文件、目录及 WAL 相关文件的权限由管理员设置；不要让服务以管理员身份运行。

SQLite 查询子进程继承同一操作系统账户，只隔离查询的阻塞和超时，不提供身份隔离。`config/databases.json`、`.gitignore` 和 agent 行为约定也不提供同账户强凭证隔离。

## 凭证和网络

- 用户手动维护 `config/databases.json`，限制其他账户的文件读取权限，不将其同步到公开位置。
- PostgreSQL 远程连接使用验证服务器证书的 TLS 配置；MySQL 使用 JSON 中的 `tls: true` 并配置信任链。不要为了连接成功关闭证书验证。
- MCP 服务、数据库对象和扩展由可信管理员控制。SQL 检查不保证恶意服务器代码没有外部副作用。
- 只读账户不自动隐藏密码列；通过授予限定视图或限定数据文件限制 agent 可见内容。
- 定期轮换凭证；修改 `config/databases.json` 后重启服务以加载新配置。已经泄露的凭证必须撤销或轮换，不能只删除文件。
- `.gitignore` 不会自动清除已被 Git 跟踪的文件或历史中的秘密。
