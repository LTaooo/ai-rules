import { ErrorCode } from '../../../domain/enums/ErrorCode.js';
import { DatabaseSync } from 'node:sqlite';
import { ResultProcessor } from '../../../shared/results/ResultProcessor.js';
import { SafeError } from '../../../shared/errors/SafeError.js';
import type { Limits } from '../../../domain/models/AppConfig.js';

import type { Parameter, RawResult } from '../../../domain/models/QueryResult.js';

interface Work {
    filename: string;
    sql: string;
    parameters: Parameter[];
    limits: Limits;
}

export class SqliteWorker {
    /** 执行受限任务并在 finally 释放资源或并发计数，不吞掉安全错误。 */
    public static execute(work: Work): void {
        let database: DatabaseSync | undefined;
        let response: { result: RawResult } | { error: string };
        try {
            database = new DatabaseSync(work.filename, {
                readOnly: true,
                allowExtension: false,
                enableDoubleQuotedStringLiterals: false,
                timeout: work.limits.timeoutMs,
            });
            database.exec('PRAGMA query_only = ON');
            const statement = database.prepare(work.sql);
            statement.setReadBigInts(true);
            statement.setReturnArrays(true);
            const columns = statement.columns().map((column) => column.name);
            if (columns.length === 0) throw new SafeError(ErrorCode.SqlRejected);
            const result: RawResult = { columns, rows: [] };
            let bytes = ResultProcessor.checkBytes(columns, work.limits.maxResponseBytes);
            for (const row of statement.iterate(
                ...work.parameters.map((parameter) =>
                    typeof parameter === 'boolean' ? Number(parameter) : parameter,
                ),
            )) {
                const values = row as unknown as unknown[];
                bytes += ResultProcessor.checkBytes(values, work.limits.maxResponseBytes);
                if (bytes > work.limits.maxResponseBytes)
                    throw new SafeError(ErrorCode.ResultTooLarge);
                result.rows.push(values);
                if (result.rows.length > work.limits.maxRows) break;
            }
            response = { result };
        } catch (error) {
            response = { error: error instanceof SafeError ? error.code : ErrorCode.DatabaseError };
        } finally {
            database?.close();
        }
        process.send?.(response, () => process.disconnect?.());
    }
}
process.once('message', (work: Work) => SqliteWorker.execute(work));
