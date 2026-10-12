import { isAbsolute } from 'node:path';
import { Dialect } from '../../domain/enums/Dialect.js';
import { SslMode } from '../../domain/enums/SslMode.js';
import { ErrorCode } from '../../domain/enums/ErrorCode.js';
import { DatabaseConfig } from '../../domain/models/DatabaseConfig.js';
import { SafeError } from '../../shared/errors/SafeError.js';
import type { Limits } from '../../domain/models/AppConfig.js';

export class SourceSchema {
    /** 内置查询安全上限；无配置文件，全部数据源共用同一组默认。 */
    public static readonly defaultLimits: Readonly<Limits> = Object.freeze({
        maxRows: 1000,
        timeoutMs: 10000,
        maxResponseBytes: 1048576,
        maxConcurrency: 4,
    });
    /** 数据源公开别名的允许字符集。 */
    public static readonly namePattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
    /**
     * 校验单条数据源对象并构造领域配置；密码字段仅存在于凭据 blob 的 JSON 中。
     * @param value 待校验的原始数据源对象。
     * @returns 不可变的数据源领域配置。
     */
    public static validateDatabase(value: unknown): DatabaseConfig {
        const raw = SourceSchema.object(value);
        const name = SourceSchema.string(raw.name);
        if (!SourceSchema.namePattern.test(name)) throw new SafeError(ErrorCode.ConfigError);
        const type = SourceSchema.dialect(raw.type);
        const description = SourceSchema.string(raw.description);
        if (type === Dialect.SQLite) {
            SourceSchema.keys(raw, ['name', 'type', 'description', 'filename']);
            const filename = SourceSchema.string(raw.filename);
            if (!isAbsolute(filename) || filename.includes(':memory:'))
                throw new SafeError(ErrorCode.ConfigError);
            return new DatabaseConfig({ name, type, description, filename });
        }
        SourceSchema.keys(raw, [
            'name',
            'type',
            'description',
            'host',
            'port',
            'database',
            'username',
            'password',
            ...(type === Dialect.PostgreSQL ? ['sslMode'] : ['tls']),
        ]);
        const password = SourceSchema.string(raw.password);
        if (password.length > 1024) throw new SafeError(ErrorCode.ConfigError);
        const config = {
            name,
            type,
            description,
            host: SourceSchema.string(raw.host),
            port: SourceSchema.integer(raw.port, type === Dialect.PostgreSQL ? 5432 : 3306, 65535),
            database: SourceSchema.string(raw.database),
            username: SourceSchema.string(raw.username),
            password,
        };
        if (config.database.includes('/')) throw new SafeError(ErrorCode.ConfigError);
        if (type === Dialect.PostgreSQL)
            return new DatabaseConfig({ ...config, sslMode: SourceSchema.sslMode(raw.sslMode) });
        if (raw.tls !== undefined && typeof raw.tls !== 'boolean')
            throw new SafeError(ErrorCode.ConfigError);
        return new DatabaseConfig({ ...config, tls: raw.tls === true });
    }
    /**
     * 解析凭据 blob 中的 JSON 文本并校验为领域配置，解析失败转换为安全错误。
     * @param payload 凭据 blob 的 UTF-8 JSON 文本。
     * @returns 不可变的数据源领域配置。
     */
    public static parse(payload: string): DatabaseConfig {
        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch {
            throw new SafeError(ErrorCode.ConfigError);
        }
        return SourceSchema.validateDatabase(parsed);
    }
    /** 根据固定枚举解析方言，非法值不进入驱动层。 */
    private static dialect(value: unknown): Dialect {
        if (value === Dialect.SQLite || value === Dialect.PostgreSQL || value === Dialect.MySQL)
            return value;
        throw new SafeError(ErrorCode.ConfigError);
    }
    /** 验证 TLS 模式；默认要求加密，verify-full 同时验证服务端证书。 */
    private static sslMode(value: unknown): SslMode {
        if (value === undefined) return SslMode.Require;
        if (value === SslMode.Disable || value === SslMode.Require || value === SslMode.VerifyFull)
            return value;
        throw new SafeError(ErrorCode.ConfigError);
    }
    /** 拒绝非普通 JSON 对象，防止把数组或 null 当作字段集合。 */
    private static object(value: unknown): Record<string, unknown> {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new SafeError(ErrorCode.ConfigError);
        return value as Record<string, unknown>;
    }
    /** 拒绝未知字段，不允许环境变量引用或凭据间接层残留。 */
    private static keys(value: Record<string, unknown>, allowed: string[]): void {
        if (Object.keys(value).some((key) => !allowed.includes(key)))
            throw new SafeError(ErrorCode.ConfigError);
    }
    /** 验证必填非空字符串，不对凭证执行改变其内容的 trim 操作。 */
    private static string(value: unknown): string {
        if (typeof value !== 'string' || value.length === 0)
            throw new SafeError(ErrorCode.ConfigError);
        return value;
    }
    /** 只允许安全正整数；缺省值使用既定默认值。 */
    private static integer(value: unknown, fallback: number, maximum: number): number {
        if (value === undefined) return fallback;
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
            throw new SafeError(ErrorCode.ConfigError);
        return value as number;
    }
}
