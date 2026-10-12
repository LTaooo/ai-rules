import { Limits } from '../models/AppConfig.js';
import { Parameter, RawResult } from '../models/QueryResult.js';

export interface DatabaseAdapter {
    /**
     * 执行参数绑定的只读查询；限制时间、行数与字节，结束后释放资源。
     * @param sql 经策略验证的单条只读语句。
     * @param parameters 与语句占位符对应的绑定参数。
     * @param limits 行数、超时与响应大小限制。
     * @returns 原始列名与二维行数据。
     */
    query(sql: string, parameters: Parameter[], limits: Limits): Promise<RawResult>;
    /**
     * 使用绑定参数查询可见表结构；table 精确匹配，tableLike 模糊过滤，拒绝越界 schema。
     * @param schema 限定结构所属 schema，SQLite 不支持。
     * @param table 精确表名，缺省时查询全部可见表。
     * @param tableLike 表名模糊模式，与 table 互斥。
     * @param limits 行数、超时与响应大小限制。
     * @returns 原始列与行数据。
     */
    describe(
        schema: string | undefined,
        table: string | undefined,
        tableLike: string | undefined,
        limits: Limits,
    ): Promise<RawResult>;
    /** 关闭跟踪中的连接或隔离进程，重复调用不会恢复已关闭服务。 */
    close(): Promise<void>;
}
