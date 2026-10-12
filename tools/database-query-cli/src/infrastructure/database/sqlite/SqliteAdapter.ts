import { ErrorCode } from '../../../domain/enums/ErrorCode.js';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { SafeError } from '../../../shared/errors/SafeError.js';

import type { Limits } from '../../../domain/models/AppConfig.js';
import type { DatabaseConfig } from '../../../domain/models/DatabaseConfig.js';
import type { DatabaseAdapter } from '../../../domain/ports/DatabaseAdapter.js';
import type { Parameter, RawResult } from '../../../domain/models/QueryResult.js';

export class SqliteAdapter implements DatabaseAdapter {
    private readonly children = new Set<ChildProcess>();
    private closed = false;
    /** 保存数据源配置；查询子进程逐次创建并登记，以便超时与关闭时统一回收。 */
    constructor(private readonly config: DatabaseConfig) {}

    /** 执行参数绑定的只读查询；限制时间、行数与字节，结束后释放资源。 */
    async query(sql: string, parameters: Parameter[], limits: Limits): Promise<RawResult> {
        if (this.closed) throw new SafeError(ErrorCode.Closed);
        return new Promise((resolve, reject) => {
            // 原生 SQLite 调用可能无法及时响应终止信号，因此查询必须在独立子进程中执行。
            const child = fork(
                new URL(
                    import.meta.url.endsWith('.ts')
                        ? '../../../../dist/infrastructure/database/sqlite/SqliteWorker.js'
                        : './SqliteWorker.js',
                    import.meta.url,
                ),
                [],
                {
                    serialization: 'advanced',
                    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                    env: {},
                    execArgv: ['--max-old-space-size=64'],
                    windowsHide: true,
                },
            );
            this.children.add(child);
            let timedOut = false;
            let response: { result?: RawResult; error?: ErrorCode } | undefined;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, limits.timeoutMs);
            child.once('message', (message: { result?: RawResult; error?: ErrorCode }) => {
                response = message;
            });
            child.once('error', () => {
                clearTimeout(timer);
                this.children.delete(child);
                reject(new SafeError(ErrorCode.DatabaseError));
            });
            child.once('exit', () => {
                this.children.delete(child);
                clearTimeout(timer);
                if (timedOut) reject(new SafeError(ErrorCode.Timeout));
                else if (this.closed) reject(new SafeError(ErrorCode.Closed));
                else if (response?.result) resolve(response.result);
                else reject(new SafeError(response?.error ?? ErrorCode.DatabaseError));
            });
            child.send({ filename: this.config.filename, sql, parameters, limits });
        });
    }

    /** 使用绑定参数查询可见表结构；table 精确匹配，tableLike 模糊过滤，拒绝越界 schema。 */
    async describe(
        schema: string | undefined,
        table: string | undefined,
        tableLike: string | undefined,
        limits: Limits,
    ): Promise<RawResult> {
        if (schema) throw new SafeError(ErrorCode.InvalidRequest);
        return this.query(
            "SELECT NULL AS schema_name, m.name AS table_name, m.type AS table_type, p.name AS column_name, p.type AS data_type, p.\"notnull\" = 0 AS nullable, p.pk > 0 AS primary_key FROM sqlite_schema AS m JOIN pragma_table_info(m.name) AS p WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' AND (? IS NULL OR m.name = ?) AND (? IS NULL OR m.name LIKE ?) ORDER BY m.name, p.cid",
            [table ?? null, table ?? null, tableLike ?? null, tableLike ?? null],
            limits,
        );
    }

    /** 关闭跟踪中的连接或隔离进程，重复调用不会恢复已关闭服务。 */
    async close(): Promise<void> {
        this.closed = true;
        await Promise.all(
            [...this.children].map(
                (child) =>
                    new Promise<void>((resolve) => {
                        if (child.exitCode !== null || child.signalCode !== null) {
                            resolve();
                            return;
                        }
                        child.once('exit', () => resolve());
                        child.kill('SIGKILL');
                    }),
            ),
        );
    }
}
