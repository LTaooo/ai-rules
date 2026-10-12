import type { Limits } from '../../domain/models/AppConfig.js';

import type { RawResult, QueryResult } from '../../domain/models/QueryResult.js';
import { ErrorCode } from '../../domain/enums/ErrorCode.js';
import { SafeError } from '../errors/SafeError.js';

export class ResultProcessor {
    /**
     * 递归转换精确整数、日期和二进制为可 JSON 序列化值，不修改原数据。
     * @param value 驱动返回的原始单元格值。
     * @returns 可被 JSON.stringify 安全序列化的值。
     */
    public static normalize(value: unknown): unknown {
        if (typeof value === 'bigint') return value.toString();
        if (value instanceof Date) return value.toISOString();
        if (value instanceof Uint8Array)
            return { type: 'binary', base64: Buffer.from(value).toString('base64') };
        if (Array.isArray(value)) return value.map((child) => ResultProcessor.normalize(child));
        if (value !== null && typeof value === 'object')
            return Object.fromEntries(
                Object.entries(value).map(([key, child]) => [
                    key,
                    ResultProcessor.normalize(child),
                ]),
            );
        if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
        return value;
    }

    /**
     * 计算规范化 JSON 的 UTF-8 字节数，超出上限抛出安全错误。
     * @param value 待统计的规范化值。
     * @param maximum 允许的最大字节数。
     * @returns 实际 UTF-8 字节数。
     */
    public static checkBytes(value: unknown, maximum: number): number {
        const bytes = Buffer.byteLength(JSON.stringify(ResultProcessor.normalize(value)));
        if (bytes > maximum) throw new SafeError(ErrorCode.ResultTooLarge);
        return bytes;
    }

    /**
     * 截断超额行并规范化结果，校验返回字节数与记录执行耗时。
     * @param raw 适配器返回的原始结果。
     * @param limits 行数与响应大小限制。
     * @param start 查询开始的性能时钟读数。
     * @returns 规范化后的最终查询结果。
     */
    public static finishResult(raw: RawResult, limits: Limits, start: number): QueryResult {
        const rows = raw.rows
            .slice(0, limits.maxRows)
            .map((row) => row.map((child) => ResultProcessor.normalize(child)));
        const result = {
            columns: raw.columns,
            rows,
            rowCount: rows.length,
            truncated: raw.rows.length > limits.maxRows,
            durationMs: Math.round(performance.now() - start),
        };
        ResultProcessor.checkBytes(result, limits.maxResponseBytes);
        return result;
    }
}
