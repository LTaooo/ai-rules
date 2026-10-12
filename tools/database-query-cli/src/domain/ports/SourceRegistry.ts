import type { DatabaseConfig } from '../models/DatabaseConfig.js';

export interface SourceRegistry {
    /** 列出全部已配置数据源；无法解析的无关条目被跳过。 */
    list(): Promise<DatabaseConfig[]>;
    /** 按别名返回数据源配置，别名不存在时抛出 NotFound。 */
    get(name: string): Promise<DatabaseConfig>;
}
