/** 支持的数据库方言，与配置中的 type 字段一一对应。 */
export enum Dialect {
    /** 本地 SQLite 文件数据库，无需密码。 */
    SQLite = 'sqlite',
    /** PostgreSQL 服务端数据库。 */
    PostgreSQL = 'postgres',
    /** MySQL 服务端数据库。 */
    MySQL = 'mysql',
}
