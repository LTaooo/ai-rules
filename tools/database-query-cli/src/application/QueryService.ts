import { LogEvent } from '../domain/enums/LogEvent.js';
import { ErrorCode } from '../domain/enums/ErrorCode.js';
import { z } from 'zod';
import { DatabaseAdapterFactory } from '../infrastructure/database/DatabaseAdapterFactory.js';
import { SafeError } from '../shared/errors/SafeError.js';
import { ResultProcessor } from '../shared/results/ResultProcessor.js';
import { SqlPolicy } from '../security/SqlPolicy.js';
import { Logger } from '../infrastructure/logging/Logger.js';
import { SourceSchema } from '../infrastructure/config/SourceSchema.js';
import type { Limits } from '../domain/models/AppConfig.js';
import type { DatabaseConfig } from '../domain/models/DatabaseConfig.js';
import type { DatabaseAdapter } from '../domain/ports/DatabaseAdapter.js';
import type { SourceRegistry } from '../domain/ports/SourceRegistry.js';
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
        tableLike: z.string().min(1).max(256).optional(),
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
    private readonly cachedSources = new Map<string, DatabaseConfig>();
    private readonly active = new Map<string, number>();
    private closed = false;
    private closing: Promise<void> | undefined;
    /** 初始化依赖与资源状态，不在构造期间执行查询；数据源来自凭据管理器注册表。 */
    constructor(
        private readonly registry: SourceRegistry,
        private readonly limits: Limits = SourceSchema.defaultLimits,
        private readonly factory: (
            config: DatabaseConfig,
        ) => DatabaseAdapter = DatabaseAdapterFactory.create,
        private readonly logger: Logger = new Logger(),
    ) {}
    /** 惰性创建适配器并按别名缓存，避免重复建立连接或子进程。 */
    private adapterFor(source: DatabaseConfig): DatabaseAdapter {
        let adapter = this.adapters.get(source.name);
        if (!adapter) {
            adapter = this.factory(source);
            this.adapters.set(source.name, adapter);
        }
        return adapter;
    }

    /**
     * 返回数据源的公开投影，不返回用户名、密码或地址。
     * @returns 数据源别名、类型与描述组成的列表。
     */
    async listDatabases(): Promise<{ name: string; type: string; description?: string }[]> {
        return (await this.registry.list()).map((database) => database.publicInfo);
    }

    /** 查找命名数据源并按别名缓存，拒绝已关闭服务与不存在的名称。 */
    private async source(name: string): Promise<DatabaseConfig> {
        if (this.closed) throw new SafeError(ErrorCode.Closed);
        const cached = this.cachedSources.get(name);
        if (cached) return cached;
        const source = await this.registry.get(name);
        this.cachedSources.set(name, source);
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
            const adapter = this.adapterFor(source);
            return ResultProcessor.finishResult(await action(adapter), limits, start);
        } catch (error) {
            throw SafeError.from(error);
        } finally {
            this.active.set(source.name, (this.active.get(source.name) ?? 1) - 1);
        }
    }

    /**
     * 执行参数绑定的只读查询；限制时间、行数与字节，结束后释放资源。
     * @param input 包含 database、sql、可选 parameters 与 maxRows 的原始输入。
     * @returns 列名、二维行、行数、截断标识与耗时组成的查询结果。
     */
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
            const source = await this.source(request.database);
            const sql = SqlPolicy.validateSql(request.sql, source.type);
            const limits = {
                ...this.limits,
                maxRows: request.maxRows ?? this.limits.maxRows,
            };
            if (limits.maxRows > this.limits.maxRows) throw new SafeError(ErrorCode.InvalidRequest);
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

    /**
     * 返回数据源的业务标识与 TLS 配置，不包含主机、端口、用户名等侦察信息。
     * @returns 除密码与连接地址外的数据源标识字段。
     */
    async showSource(name: string): Promise<Record<string, unknown>> {
        const source = await this.source(name);
        return {
            name: source.name,
            type: source.type,
            description: source.description,
            database: source.database,
            filename: source.filename,
            sslMode: source.sslMode,
            tls: source.tls,
        };
    }

    /** 规范化表名模糊模式：glob 星号转换为 SQL 通配符，不含通配符时按包含匹配。 */
    private normalizeTableLike(pattern: string): string {
        const translated = pattern.replace(/\*/g, '%').replace(/\?/g, '_');
        return translated.includes('%') ? translated : `%${translated}%`;
    }

    /**
     * 使用绑定参数查询可见表结构；无精确表名时截断视为范围过宽，拒绝返回不完整结构。
     * @param input 包含 database、可选 schema、table 与 tableLike 的原始输入。
     * @returns 表与列的结构化信息，含截断标识与耗时。
     */
    async describe(input: unknown): Promise<QueryResult> {
        const requestId = crypto.randomUUID();
        const parsed = describeInput.safeParse(input);
        if (!parsed.success) {
            this.logger.warn(LogEvent.SchemaRejected, { requestId, code: 'INVALID_REQUEST' });
            throw new SafeError(ErrorCode.InvalidRequest);
        }
        const request = parsed.data;
        if (request.table && request.tableLike) {
            this.logger.warn(LogEvent.SchemaRejected, { requestId, code: 'INVALID_REQUEST' });
            throw new SafeError(ErrorCode.InvalidRequest);
        }
        this.logger.info(LogEvent.SchemaReceived, { requestId, database: request.database });
        try {
            const source = await this.source(request.database);
            const tableLike =
                request.tableLike === undefined
                    ? undefined
                    : this.normalizeTableLike(request.tableLike);
            const result = await this.execute(source, this.limits, (adapter) =>
                adapter.describe(request.schema, request.table, tableLike, this.limits),
            );
            if (request.table && result.rowCount === 0) throw new SafeError(ErrorCode.NotFound);
            if (result.truncated && !request.table) throw new SafeError(ErrorCode.ResultTooLarge);
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

    /** 关闭跟踪中的连接或隔离进程，重复调用不会恢复已关闭服务。 */
    close(): Promise<void> {
        this.closed = true;
        this.closing ??= Promise.all(
            [...this.adapters.values()].map((adapter) => adapter.close()),
        ).then(() => undefined);
        return this.closing;
    }
}
