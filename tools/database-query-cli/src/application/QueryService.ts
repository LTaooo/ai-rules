import { LogEvent } from '../domain/enums/LogEvent.js';
import { ErrorCode } from '../domain/enums/ErrorCode.js';
import { z } from 'zod';
import { DatabaseAdapterFactory } from '../infrastructure/database/DatabaseAdapterFactory.js';
import { SafeError } from '../shared/errors/SafeError.js';
import { ResultProcessor } from '../shared/results/ResultProcessor.js';
import { SqlPolicy } from '../security/SqlPolicy.js';
import { Logger } from '../infrastructure/logging/Logger.js';
import type { AppConfig as Config, Limits } from '../domain/models/AppConfig.js';
import type { DatabaseConfig } from '../domain/models/DatabaseConfig.js';
import type { DatabaseAdapter } from '../domain/ports/DatabaseAdapter.js';
import type { RawResult, QueryResult } from '../domain/models/QueryResult.js';

export const queryInput = z
    .object({
        database: z.string().min(1).max(128),
        sql: z.string().min(1).max(65536),
        parameters: z
            .array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
            .max(1000)
            .optional(),
        maxRows: z.number().int().positive().optional(),
    })
    .strict();
export const describeInput = z
    .object({
        database: z.string().min(1).max(128),
        schema: z.string().min(1).max(256).optional(),
        table: z.string().min(1).max(256).optional(),
    })
    .strict();

export class QueryService {
    /** 按安全错误类别记录严重级别，不输出原始异常。 */
    private static logFailure(
        logger: Logger,
        event: LogEvent,
        fields: { requestId: string; database: string; code: ErrorCode },
    ): void {
        if (
            [ErrorCode.DatabaseError, ErrorCode.ReadOnlyRequired, ErrorCode.Timeout].includes(
                fields.code,
            )
        ) {
            logger.error(event, fields);
        } else {
            logger.warn(event, fields);
        }
    }

    private readonly adapters = new Map<string, DatabaseAdapter>();
    private readonly active = new Map<string, number>();
    private closed = false;
    private closing: Promise<void> | undefined;
    /** 初始化依赖与资源状态，不在构造期间执行查询。 */
    constructor(
        private readonly config: Config,
        private readonly factory: (
            config: DatabaseConfig,
        ) => DatabaseAdapter = DatabaseAdapterFactory.create,
        private readonly logger: Logger = new Logger(),
    ) {}

    /** 返回数据源的公开投影，不返回用户名、密码或地址。 */
    listDatabases(): { name: string; type: string; description?: string }[] {
        return this.config.databases.map((database) => database.publicInfo);
    }

    /** 查找命名数据源，拒绝已关闭服务与不存在的名称。 */
    private source(name: string): DatabaseConfig {
        if (this.closed) throw new SafeError(ErrorCode.Closed);
        const source = this.config.databases.find((database) => database.name === name);
        if (!source) throw new SafeError(ErrorCode.NotFound);
        return source;
    }

    /** 执行受限任务并在 finally 释放资源或并发计数，不吞掉安全错误。 */
    private async execute(
        source: DatabaseConfig,
        limits: Limits,
        action: (adapter: DatabaseAdapter) => Promise<RawResult>,
    ): Promise<QueryResult> {
        const count = this.active.get(source.name) ?? 0;
        if (count >= limits.maxConcurrency) throw new SafeError(ErrorCode.Busy);
        this.active.set(source.name, count + 1);
        const start = performance.now();
        try {
            let adapter = this.adapters.get(source.name);
            if (!adapter) {
                adapter = this.factory(source);
                this.adapters.set(source.name, adapter);
            }
            return ResultProcessor.finishResult(await action(adapter), limits, start);
        } catch (error) {
            throw SafeError.from(error);
        } finally {
            this.active.set(source.name, (this.active.get(source.name) ?? 1) - 1);
        }
    }

    /** 执行参数绑定的只读查询；限制时间、行数与字节，结束后释放资源。 */
    async query(input: unknown): Promise<QueryResult> {
        const requestId = crypto.randomUUID();
        const parsed = queryInput.safeParse(input);
        if (!parsed.success) {
            this.logger.warn(LogEvent.QueryRejected, { requestId, code: 'INVALID_REQUEST' });
            throw new SafeError(ErrorCode.InvalidRequest);
        }
        const request = parsed.data;
        this.logger.info(LogEvent.QueryReceived, { requestId, database: request.database });
        try {
            const source = this.source(request.database);
            const sql = SqlPolicy.validateSql(request.sql, source.type);
            const limits = {
                ...this.config.limits,
                maxRows: request.maxRows ?? this.config.limits.maxRows,
            };
            if (limits.maxRows > this.config.limits.maxRows)
                throw new SafeError(ErrorCode.InvalidRequest);
            const result = await this.execute(source, limits, (adapter) =>
                adapter.query(sql, request.parameters ?? [], limits),
            );
            this.logger.info(LogEvent.QueryCompleted, {
                requestId,
                database: request.database,
                durationMs: result.durationMs,
                returnedRows: result.rowCount,
                truncated: result.truncated,
            });
            return result;
        } catch (error) {
            const safe = SafeError.from(error);
            QueryService.logFailure(this.logger, LogEvent.QueryFailed, {
                requestId,
                database: request.database,
                code: safe.code,
            });
            throw safe;
        }
    }

    /** 使用绑定参数查询可见表结构，拒绝越界 schema，不拼接用户标识符。 */
    async describe(input: unknown): Promise<QueryResult> {
        const requestId = crypto.randomUUID();
        const parsed = describeInput.safeParse(input);
        if (!parsed.success) {
            this.logger.warn(LogEvent.SchemaRejected, { requestId, code: 'INVALID_REQUEST' });
            throw new SafeError(ErrorCode.InvalidRequest);
        }
        const request = parsed.data;
        this.logger.info(LogEvent.SchemaReceived, { requestId, database: request.database });
        try {
            const source = this.source(request.database);
            const result = await this.execute(source, this.config.limits, (adapter) =>
                adapter.describe(request.schema, request.table, this.config.limits),
            );
            if (request.table && result.rowCount === 0) throw new SafeError(ErrorCode.NotFound);
            this.logger.info(LogEvent.SchemaCompleted, {
                requestId,
                database: request.database,
                durationMs: result.durationMs,
                returnedRows: result.rowCount,
                truncated: result.truncated,
            });
            return result;
        } catch (error) {
            const safe = SafeError.from(error);
            QueryService.logFailure(this.logger, LogEvent.SchemaFailed, {
                requestId,
                database: request.database,
                code: safe.code,
            });
            throw safe;
        }
    }

    /** 返回完整 MCP 响应可使用的字节上限。 */
    get maxResponseBytes(): number {
        return this.config.limits.maxResponseBytes;
    }

    /** 关闭跟踪中的连接或隔离进程，重复调用不会恢复已关闭服务。 */
    close(): Promise<void> {
        this.closed = true;
        this.closing ??= Promise.all(
            [...this.adapters.values()].map((adapter) => adapter.close()),
        ).then(() => undefined);
        return this.closing;
    }
}
