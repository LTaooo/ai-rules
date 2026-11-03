import { DatabaseStage } from '../../../domain/enums/DatabaseStage.js';
import { ErrorCode } from '../../../domain/enums/ErrorCode.js';
import mysql from 'mysql2';
import type { Connection, FieldPacket } from 'mysql2';
import type { Readable } from 'node:stream';
import { Socket } from 'node:net';
import { SafeError } from '../../../shared/errors/SafeError.js';
import { ResultProcessor } from '../../../shared/results/ResultProcessor.js';
import type { Limits } from '../../../domain/models/AppConfig.js';
import type { DatabaseConfig } from '../../../domain/models/DatabaseConfig.js';
import type { DatabaseAdapter } from '../../../domain/ports/DatabaseAdapter.js';
import type { Parameter, RawResult } from '../../../domain/models/QueryResult.js';

export class MysqlAdapter implements DatabaseAdapter {
    private readonly aborts = new Set<() => void>();
    private readonly transports = new Set<Socket>();
    private closed = false;
    /** 保存数据源配置；中止回调与底层 Socket 登记在集合中，以便超时时强制销毁。 */
    constructor(private readonly config: DatabaseConfig) {}

    /** 使用结构化配置建立单语句连接，保留底层 Socket 以支持强制取消。 */
    private connection(limits: Limits): { connection: Connection; transport: Socket } {
        const transport = new Socket();
        transport.setNoDelay(true);
        try {
            const connection = mysql.createConnection({
                host: this.config.host!,
                port: this.config.port ?? 3306,
                user: this.config.username!,
                password: this.config.password!,
                database: this.config.database!,
                connectTimeout: limits.timeoutMs,
                multipleStatements: false,
                rowsAsArray: true,
                supportBigNumbers: true,
                bigNumberStrings: true,
                dateStrings: true,
                stream: () => transport.connect(this.config.port ?? 3306, this.config.host!),
                ...(this.config.tls ? { ssl: { rejectUnauthorized: true } } : {}),
            });
            return { connection, transport };
        } catch (error) {
            transport.destroy();
            throw error;
        }
    }

    /**
     * 校验单行版本结果并返回可用的会话级超时变量；未知版本拒绝执行业务查询。
     * MySQL 5.6.5+ 与 5.7.0–5.7.7 只有客户端超时；MariaDB 自 10.1 起支持 max_statement_time。
     */
    private serverTimeoutVariable(
        result: unknown,
    ): 'MAX_EXECUTION_TIME' | 'max_statement_time' | undefined {
        if (!Array.isArray(result) || result.length !== 1)
            throw new SafeError(ErrorCode.DatabaseError);
        const row = result[0];
        if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== 'string')
            throw new SafeError(ErrorCode.DatabaseError);
        const version = row[0];
        const mysqlMatch = /^(\d+)\.(\d+)\.(\d+)(?:-(?:community(?:-log)?|log))?$/.exec(version);
        if (mysqlMatch !== null) {
            const [major, minor, patch] = mysqlMatch.slice(1).map(Number);
            if (![major, minor, patch].every(Number.isSafeInteger))
                throw new SafeError(ErrorCode.DatabaseError);
            if (major === 5 && minor === 6 && patch! >= 5) return undefined;
            if (major === 5 && minor === 7) return patch! >= 8 ? 'MAX_EXECUTION_TIME' : undefined;
            if (major === 8) return 'MAX_EXECUTION_TIME';
            throw new SafeError(ErrorCode.DatabaseError);
        }
        // 发行版构建会在 -MariaDB 后追加版本标签，如 10.4.28-MariaDB-0ubuntu0.20.04.1。
        const mariaMatch = /^(\d+)\.(\d+)\.(\d+)-MariaDB(?:-[0-9A-Za-z.+~:_-]+)?$/.exec(version);
        if (mariaMatch === null) throw new SafeError(ErrorCode.DatabaseError);
        const [major, minor] = mariaMatch.slice(1, 3).map(Number);
        if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor))
            throw new SafeError(ErrorCode.DatabaseError);
        if (major! > 10 || (major === 10 && minor! >= 1)) return 'max_statement_time';
        throw new SafeError(ErrorCode.DatabaseError);
    }

    /** 执行参数绑定的只读查询；限制时间、行数与字节，结束后释放资源。 */
    async query(sql: string, parameters: Parameter[], limits: Limits): Promise<RawResult> {
        if (this.closed) throw new SafeError(ErrorCode.Closed);
        // mysql2 的公开 destroy() 可能只做半关闭；必须显式销毁底层 Socket 才能真正断开。
        const { connection, transport } = this.connection(limits);
        this.transports.add(transport);
        const transportClosed = new Promise<void>((resolve) => {
            transport.once('close', () => {
                this.transports.delete(transport);
                resolve();
            });
        });
        const forceClose = () => {
            connection.destroy();
            transport.destroy();
        };
        connection.on('error', () => {});
        const control = connection.promise();
        let stream: Readable | undefined;
        let abort!: (error: SafeError) => void;
        const deadline = new Promise<never>((_resolve, reject) => {
            abort = (error) => {
                stream?.destroy(error);
                forceClose();
                reject(error);
            };
        });
        const timer = setTimeout(() => abort(new SafeError(ErrorCode.Timeout)), limits.timeoutMs);
        const stop = () => abort(new SafeError(ErrorCode.Closed));
        this.aborts.add(stop);
        let stage = DatabaseStage.Connect;
        const execute = async (): Promise<RawResult> => {
            await control.connect();
            stage = DatabaseStage.VersionCheck;
            const [versionRows] = await control.query('SELECT VERSION()');
            const serverTimeout = this.serverTimeoutVariable(versionRows);
            stage = DatabaseStage.ReadOnly;
            await control.query('SET SESSION TRANSACTION READ ONLY');
            if (serverTimeout !== undefined) {
                stage = DatabaseStage.Timeout;
                const value =
                    serverTimeout === 'max_statement_time'
                        ? limits.timeoutMs / 1000
                        : limits.timeoutMs;
                await control.query(`SET SESSION ${serverTimeout} = ${value}`);
            }
            stage = DatabaseStage.Begin;
            await control.query('START TRANSACTION READ ONLY');
            stage = DatabaseStage.Execute;
            const output: RawResult = { columns: [], rows: [] };
            let bytes = 0;
            const statement = connection.execute(sql, parameters);
            statement.on('error', () => {});
            statement.on('fields', (fields: FieldPacket[]) => {
                output.columns = fields.map((field) => field.name);
            });
            stream = statement.stream({ highWaterMark: 1 });
            for await (const candidate of stream) {
                if (!Array.isArray(candidate)) throw new SafeError(ErrorCode.SqlRejected);
                const row: unknown[] = candidate;
                bytes += ResultProcessor.checkBytes(row, limits.maxResponseBytes);
                if (bytes > limits.maxResponseBytes) throw new SafeError(ErrorCode.ResultTooLarge);
                output.rows.push(row);
                if (output.rows.length > limits.maxRows) {
                    forceClose();
                    break;
                }
            }
            if (output.rows.length <= limits.maxRows) {
                stage = DatabaseStage.Rollback;
                await control.query('ROLLBACK');
            }
            return output;
        };
        try {
            return await Promise.race([execute(), deadline]);
        } catch (error) {
            // MariaDB 的 max_statement_time 超时没有 ER_ 名称，驱动只保留 errno 1969。
            if (
                error !== null &&
                typeof error === 'object' &&
                (('code' in error && error.code === 'ER_QUERY_TIMEOUT') ||
                    ('errno' in error && error.errno === 1969))
            )
                throw new SafeError(ErrorCode.Timeout);
            throw SafeError.database(error, stage);
        } finally {
            clearTimeout(timer);
            stream?.destroy();
            forceClose();
            await transportClosed;
            this.aborts.delete(stop);
        }
    }

    /** 使用绑定参数查询可见表结构；table 精确匹配，tableLike 模糊过滤，拒绝越界 schema。 */
    async describe(
        schema: string | undefined,
        table: string | undefined,
        tableLike: string | undefined,
        limits: Limits,
    ): Promise<RawResult> {
        if (schema !== undefined && schema !== this.config.database)
            throw new SafeError(ErrorCode.InvalidRequest);
        return this.query(
            "SELECT c.TABLE_SCHEMA AS schema_name, c.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type, c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS data_type, c.IS_NULLABLE = 'YES' AS nullable, c.COLUMN_KEY = 'PRI' AS primary_key FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME WHERE c.TABLE_SCHEMA = ? AND (? IS NULL OR c.TABLE_NAME = ?) AND (? IS NULL OR c.TABLE_NAME LIKE ?) ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION",
            [
                this.config.database!,
                table ?? null,
                table ?? null,
                tableLike ?? null,
                tableLike ?? null,
            ],
            limits,
        );
    }

    /** 关闭跟踪中的连接或隔离进程，重复调用不会恢复已关闭服务。 */
    async close(): Promise<void> {
        this.closed = true;
        for (const stop of this.aborts) stop();
        await Promise.all(
            [...this.transports].map(
                (transport) =>
                    new Promise<void>((resolve) => {
                        transport.once('close', () => resolve());
                        transport.destroy();
                    }),
            ),
        );
    }
}
