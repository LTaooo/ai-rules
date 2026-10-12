import { ErrorCode } from '../../../domain/enums/ErrorCode.js';
import pg from 'pg';
import { SslMode } from '../../../domain/enums/SslMode.js';
import type { Client } from 'pg';
import Cursor from 'pg-cursor';
import { SafeError } from '../../../shared/errors/SafeError.js';
import { ResultProcessor } from '../../../shared/results/ResultProcessor.js';
import type { Limits } from '../../../domain/models/AppConfig.js';
import type { DatabaseConfig } from '../../../domain/models/DatabaseConfig.js';
import type { DatabaseAdapter } from '../../../domain/ports/DatabaseAdapter.js';
import type { Parameter, RawResult } from '../../../domain/models/QueryResult.js';

export class PostgresAdapter implements DatabaseAdapter {
    private readonly clients = new Set<Client>();
    private closed = false;
    /** 初始化依赖与资源状态，不在构造期间执行查询。 */
    constructor(private readonly config: DatabaseConfig) {}

    /** 执行参数绑定的只读查询；限制时间、行数与字节，结束后释放资源。 */
    async query(sql: string, parameters: Parameter[], limits: Limits): Promise<RawResult> {
        if (this.closed) throw new SafeError(ErrorCode.Closed);
        // The read-only transaction is a database-enforced second barrier behind SQL policy validation.
        const client = new pg.Client({
            host: this.config.host,
            port: this.config.port,
            database: this.config.database,
            user: this.config.username,
            password: this.config.password,
            ssl:
                this.config.sslMode === SslMode.Disable
                    ? false
                    : { rejectUnauthorized: this.config.sslMode === SslMode.VerifyFull },
            connectionTimeoutMillis: limits.timeoutMs,
            statement_timeout: limits.timeoutMs,
            query_timeout: limits.timeoutMs,
            application_name: 'database-query-mcp',
        });
        client.on('error', () => {});
        this.clients.add(client);
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                void client.end().catch(() => {});
                reject(new SafeError(ErrorCode.Timeout));
            }, limits.timeoutMs);
        });
        const execute = async (): Promise<RawResult> => {
            await client.connect();
            await client.query('BEGIN READ ONLY');
            const protection = await client.query<{ transaction_read_only: string }>(
                'SHOW transaction_read_only',
            );
            if (protection.rows[0]?.transaction_read_only !== 'on')
                throw new SafeError(ErrorCode.ReadOnlyRequired);
            const roles = await client.query<{
                rolsuper: boolean;
                rolcreatedb: boolean;
                rolcreaterole: boolean;
                rolreplication: boolean;
            }>(
                'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = current_user',
            );
            const role = roles.rows[0];
            if (
                !role ||
                role.rolsuper ||
                role.rolcreatedb ||
                role.rolcreaterole ||
                role.rolreplication
            )
                throw new SafeError(ErrorCode.ReadOnlyRequired);
            await client.query(`SET LOCAL statement_timeout = ${limits.timeoutMs}`);
            await client.query('SET LOCAL search_path = pg_catalog, public');
            const cursor = client.query(
                new Cursor<unknown[]>(sql, parameters, { rowMode: 'array' }),
            );
            const output: RawResult = { columns: [], rows: [] };
            let bytes = 0;
            try {
                while (output.rows.length <= limits.maxRows) {
                    const batch = await new Promise<{ rows: unknown[][]; columns: string[] }>(
                        (resolve, reject) => {
                            cursor.read(
                                Math.min(64, limits.maxRows + 1 - output.rows.length),
                                (error, rows, result) => {
                                    if (error) reject(error);
                                    else
                                        resolve({
                                            rows,
                                            columns: result.fields.map((field) => field.name),
                                        });
                                },
                            );
                        },
                    );
                    output.columns = batch.columns;
                    for (const row of batch.rows) {
                        bytes += ResultProcessor.checkBytes(row, limits.maxResponseBytes);
                        if (bytes > limits.maxResponseBytes)
                            throw new SafeError(ErrorCode.ResultTooLarge);
                        output.rows.push(row);
                    }
                    if (batch.rows.length === 0) break;
                }
            } finally {
                if (!timedOut) await cursor.close();
            }
            await client.query('ROLLBACK');
            return output;
        };
        try {
            return await Promise.race([execute(), deadline]);
        } catch (error) {
            if (
                timedOut ||
                (error !== null &&
                    typeof error === 'object' &&
                    'code' in error &&
                    error.code === '57014')
            )
                throw new SafeError(ErrorCode.Timeout);
            throw error;
        } finally {
            clearTimeout(timer);
            this.clients.delete(client);
            await client.end().catch(() => {});
        }
    }

    /** 使用绑定参数查询可见表结构；table 精确匹配，tableLike 模糊过滤，拒绝越界 schema。 */
    async describe(
        schema: string | undefined,
        table: string | undefined,
        tableLike: string | undefined,
        limits: Limits,
    ): Promise<RawResult> {
        return this.query(
            "SELECT n.nspname AS schema_name, c.relname AS table_name, CASE WHEN c.relkind = 'v' THEN 'view' ELSE 'table' END AS table_type, a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, NOT a.attnotnull AS nullable, EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS primary_key FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped AND ($2::text IS NULL OR c.relname = $2) AND ($3::text IS NULL OR c.relname LIKE $3) AND has_table_privilege(c.oid, 'SELECT') ORDER BY c.relname, a.attnum",
            [schema ?? 'public', table ?? null, tableLike ?? null],
            limits,
        );
    }

    /** 关闭跟踪中的连接或隔离进程，重复调用不会恢复已关闭服务。 */
    async close(): Promise<void> {
        this.closed = true;
        await Promise.all([...this.clients].map((client) => client.end().catch(() => {})));
    }
}
