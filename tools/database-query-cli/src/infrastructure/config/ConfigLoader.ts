import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { AppConfig, type Limits } from '../../domain/models/AppConfig.js';
import { DatabaseConfig } from '../../domain/models/DatabaseConfig.js';
import { Dialect } from '../../domain/enums/Dialect.js';
import { SslMode } from '../../domain/enums/SslMode.js';
import { ErrorCode } from '../../domain/enums/ErrorCode.js';
import { SafeError } from '../../shared/errors/SafeError.js';

export class ConfigLoader {
    private static readonly defaultLimits: Readonly<Limits> = Object.freeze({
        maxRows: 1000,
        timeoutMs: 10000,
        maxResponseBytes: 1048576,
        maxConcurrency: 4,
    });
    /** 保存配置路径与解析相对路径的工作目录；不读取环境或真实配置。 */
    constructor(
        private readonly filename: string = 'config/databases.json',
        private readonly cwd: string = process.cwd(),
    ) {}
    /** 读取指定 JSON，严格验证并将所有配置异常转换为不含原始值的安全错误。 */
    public load(): AppConfig {
        try {
            const raw = this.object(
                JSON.parse(readFileSync(resolve(this.cwd, this.filename), 'utf8')),
            );
            this.keys(raw, ['limits', 'databases']);
            if (
                !Array.isArray(raw.databases) ||
                raw.databases.length < 1 ||
                raw.databases.length > 64
            )
                throw new SafeError(ErrorCode.ConfigError);
            const names = new Set<string>();
            const databases = raw.databases.map((value: unknown) => this.database(value, names));
            return new AppConfig(databases, this.limits(raw.limits));
        } catch {
            throw new SafeError(ErrorCode.ConfigError);
        }
    }
    /** 只接受 --config 路径参数，拒绝重复、未知和缺值参数。 */
    public static fromArguments(
        args: string[] = process.argv.slice(2),
        cwd: string = process.cwd(),
    ): ConfigLoader {
        if (args.length === 0) return new ConfigLoader(undefined, cwd);
        if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--'))
            throw new SafeError(ErrorCode.ConfigError);
        return new ConfigLoader(args[1], cwd);
    }
    /** 验证单个数据源；仅允许公开别名、描述与明确的结构化连接字段。 */
    private database(value: unknown, names: Set<string>): DatabaseConfig {
        const raw = this.object(value);
        const name = this.string(raw.name);
        if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(name) || names.has(name))
            throw new SafeError(ErrorCode.ConfigError);
        names.add(name);
        const type = this.dialect(raw.type);
        const description = this.string(raw.description);
        const common = { name, type, description };
        if (type === Dialect.SQLite) {
            this.keys(raw, ['name', 'type', 'description', 'filename']);
            const filename = this.string(raw.filename);
            if (
                !isAbsolute(filename) ||
                filename.includes(':memory:') ||
                !statSync(filename).isFile()
            )
                throw new SafeError(ErrorCode.ConfigError);
            return new DatabaseConfig({ ...common, filename });
        }
        this.keys(raw, [
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
        const remote = {
            ...common,
            host: this.string(raw.host),
            port: this.integer(raw.port, type === Dialect.PostgreSQL ? 5432 : 3306, 65535),
            database: this.string(raw.database),
            username: this.string(raw.username),
            password: this.string(raw.password),
        };
        if (remote.database.includes('/')) throw new SafeError(ErrorCode.ConfigError);
        if (type === Dialect.PostgreSQL)
            return new DatabaseConfig({ ...remote, sslMode: this.sslMode(raw.sslMode) });
        if (raw.tls !== undefined && typeof raw.tls !== 'boolean')
            throw new SafeError(ErrorCode.ConfigError);
        return new DatabaseConfig({ ...remote, tls: raw.tls === true });
    }
    /** 根据固定枚举解析方言，非法值不进入驱动层。 */
    private dialect(value: unknown): Dialect {
        if (value === Dialect.SQLite || value === Dialect.PostgreSQL || value === Dialect.MySQL)
            return value;
        throw new SafeError(ErrorCode.ConfigError);
    }
    /** 验证 TLS 模式；默认要求加密，verify-full 同时验证服务端证书。 */
    private sslMode(value: unknown): SslMode {
        if (value === undefined) return SslMode.Require;
        if (value === SslMode.Disable || value === SslMode.Require || value === SslMode.VerifyFull)
            return value;
        throw new SafeError(ErrorCode.ConfigError);
    }
    /** 建立独立的限制对象，保留默认值与既有安全硬上限。 */
    private limits(value: unknown): Limits {
        const raw = value === undefined ? {} : this.object(value);
        this.keys(raw, ['maxRows', 'timeoutMs', 'maxResponseBytes', 'maxConcurrency']);
        const defaults = ConfigLoader.defaultLimits;
        return {
            maxRows: this.integer(raw.maxRows, defaults.maxRows, 10000),
            timeoutMs: this.integer(raw.timeoutMs, defaults.timeoutMs, 60000),
            maxResponseBytes: this.integer(
                raw.maxResponseBytes,
                defaults.maxResponseBytes,
                10485760,
            ),
            maxConcurrency: this.integer(raw.maxConcurrency, defaults.maxConcurrency, 16),
        };
    }
    /** 拒绝非普通 JSON 对象，防止把数组或 null 当作字段集合。 */
    private object(value: unknown): Record<string, unknown> {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new SafeError(ErrorCode.ConfigError);
        return value as Record<string, unknown>;
    }
    /** 拒绝未知字段，包括旧 URL 和环境变量凭证引用。 */
    private keys(value: Record<string, unknown>, allowed: string[]): void {
        if (Object.keys(value).some((key) => !allowed.includes(key)))
            throw new SafeError(ErrorCode.ConfigError);
    }
    /** 验证必填非空字符串，不对凭证执行改变其内容的 trim 操作。 */
    private string(value: unknown): string {
        if (typeof value !== 'string' || value.length === 0)
            throw new SafeError(ErrorCode.ConfigError);
        return value;
    }
    /** 只允许安全正整数；缺省值使用既定默认值。 */
    private integer(value: unknown, fallback: number, maximum: number): number {
        if (value === undefined) return fallback;
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
            throw new SafeError(ErrorCode.ConfigError);
        return value as number;
    }
}
