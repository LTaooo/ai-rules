import { Dialect } from '../../domain/enums/Dialect.js';
import type { DatabaseAdapter } from '../../domain/ports/DatabaseAdapter.js';
import type { DatabaseConfig } from '../../domain/models/DatabaseConfig.js';
import { PostgresAdapter } from './postgres/PostgresAdapter.js';
import { MysqlAdapter } from './mysql/MysqlAdapter.js';
import { SqliteAdapter } from './sqlite/SqliteAdapter.js';
export class DatabaseAdapterFactory {
    /** 根据已验证配置构造对应组件，不解析连接 URL。 */
    public static create(config: DatabaseConfig): DatabaseAdapter {
        switch (config.type) {
            case Dialect.SQLite:
                return new SqliteAdapter(config);
            case Dialect.PostgreSQL:
                return new PostgresAdapter(config);
            case Dialect.MySQL:
                return new MysqlAdapter(config);
        }
    }
}
