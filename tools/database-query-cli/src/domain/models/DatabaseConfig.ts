import { SslMode } from '../enums/SslMode.js';
import { Dialect } from '../enums/Dialect.js';

export interface DatabaseConfigOptions {
    name: string;
    type: Dialect;
    description?: string | undefined;
    host?: string | undefined;
    port?: number | undefined;
    database?: string | undefined;
    username?: string | undefined;
    password?: string | undefined;
    filename?: string | undefined;
    sslMode?: SslMode | undefined;
    tls?: boolean | undefined;
}
export class DatabaseConfig {
    public readonly name: string;
    public readonly type: Dialect;
    public readonly description: string | undefined;
    public readonly host: string | undefined;
    public readonly port: number | undefined;
    public readonly database: string | undefined;
    public readonly username: string | undefined;
    public readonly password: string | undefined;
    public readonly filename: string | undefined;
    public readonly sslMode: SslMode | undefined;
    public readonly tls: boolean | undefined;
    /** 保存经配置加载器验证的字段，不解析 URL，不读取环境凭证。 */
    constructor(options: DatabaseConfigOptions) {
        this.name = options.name;
        this.type = options.type;
        this.description = options.description;
        this.host = options.host;
        this.port = options.port;
        this.database = options.database;
        this.username = options.username;
        this.password = options.password;
        this.filename = options.filename;
        this.sslMode = options.sslMode;
        this.tls = options.tls;
    }
    /** 仅投影公开名称、类型和描述，不暴露地址、路径与凭证。 */
    public get publicInfo(): { name: string; type: Dialect; description?: string } {
        return {
            name: this.name,
            type: this.type,
            ...(this.description ? { description: this.description } : {}),
        };
    }
}
