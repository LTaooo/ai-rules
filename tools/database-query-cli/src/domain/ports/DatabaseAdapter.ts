import { Limits } from '../models/AppConfig.js';
import { Parameter, RawResult } from '../models/QueryResult.js';

export interface DatabaseAdapter {
    /** 执行参数绑定的只读查询；限制时间、行数与字节，结束后释放资源。 */
    query(sql: string, parameters: Parameter[], limits: Limits): Promise<RawResult>;
    /** 使用绑定参数查询可见表结构；table 精确匹配，tableLike 模糊过滤，拒绝越界 schema。 */
    describe(
        schema: string | undefined,
        table: string | undefined,
        tableLike: string | undefined,
        limits: Limits,
    ): Promise<RawResult>;
    /** 关闭跟踪中的连接或隔离进程，重复调用不会恢复已关闭服务。 */
    close(): Promise<void>;
}
