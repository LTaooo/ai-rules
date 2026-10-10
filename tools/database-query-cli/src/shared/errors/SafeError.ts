import type { DatabaseStage } from '../../domain/enums/DatabaseStage.js';
import { ErrorCode } from '../../domain/enums/ErrorCode.js';

export class SafeError extends Error {
    /** 初始化依赖与资源状态，不在构造期间执行查询。 */
    constructor(public readonly code: ErrorCode) {
        super(code);
        this.name = 'SafeError';
    }

    public diagnostic?: { stage: DatabaseStage; reason: string };

    /** 将驱动异常转换为固定白名单诊断，不保留原始消息或连接信息。 */
    public static database(error: unknown, stage: DatabaseStage): SafeError {
        const safe = SafeError.from(error);
        const allowed = new Set([
            'ECONNREFUSED',
            'ENOTFOUND',
            'ETIMEDOUT',
            'ECONNRESET',
            'ER_ACCESS_DENIED_ERROR',
            'ER_DBACCESS_DENIED_ERROR',
            'ER_BAD_DB_ERROR',
            'ER_UNKNOWN_SYSTEM_VARIABLE',
            'ER_PARSE_ERROR',
            'ER_NOT_SUPPORTED_YET',
            'HANDSHAKE_SSL_ERROR',
            'HANDSHAKE_NO_SSL_SUPPORT',
            'AUTH_SWITCH_PLUGIN_ERROR',
            'PROTOCOL_CONNECTION_LOST',
            'ER_QUERY_TIMEOUT',
        ]);
        const code =
            error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        safe.diagnostic = {
            stage,
            reason: typeof code === 'string' && allowed.has(code) ? code : 'UNKNOWN',
        };
        return safe;
    }

    /** 保留已脱敏错误，将未知异常转换为数据库安全错误。 */
    public static from(error: unknown): SafeError {
        return error instanceof SafeError ? error : new SafeError(ErrorCode.DatabaseError);
    }
}
