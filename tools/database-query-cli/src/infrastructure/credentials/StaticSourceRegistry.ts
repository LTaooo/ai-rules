import { ErrorCode } from '../../domain/enums/ErrorCode.js';
import { DatabaseConfig } from '../../domain/models/DatabaseConfig.js';
import type { SourceRegistry } from '../../domain/ports/SourceRegistry.js';
import { SourceSchema } from '../config/SourceSchema.js';
import { SafeError } from '../../shared/errors/SafeError.js';

/** 测试专用的内存数据源注册表，只承载合成数据，生产环境不启用。 */
export class StaticSourceRegistry implements SourceRegistry {
    private readonly sources: DatabaseConfig[];
    /** 以经验证的数据源列表构造只读注册表。 */
    constructor(sources: DatabaseConfig[]) {
        this.sources = [...sources];
    }
    /** 从测试环境变量解析注册表；变量缺失或内容非法时返回 undefined。 */
    public static tryFromEnvironment(): StaticSourceRegistry | undefined {
        const raw = process.env.DATABASE_QUERY_TEST_SOURCES;
        if (!raw) return undefined;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return undefined;
        }
        if (!Array.isArray(parsed)) return undefined;
        return new StaticSourceRegistry(
            parsed.map((value) => SourceSchema.validateDatabase(value)),
        );
    }
    /** 返回全部数据源的浅拷贝列表。 */
    public list(): Promise<DatabaseConfig[]> {
        return Promise.resolve([...this.sources]);
    }
    /** 按别名返回数据源配置，别名不存在时抛出 NotFound。 */
    public get(name: string): Promise<DatabaseConfig> {
        const source = this.sources.find((database) => database.name === name);
        if (!source) throw new SafeError(ErrorCode.NotFound);
        return Promise.resolve(source);
    }
}
