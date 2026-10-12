/** 结构化日志事件名，值使用点分命名空间并只出现在 stderr 日志中。 */
export enum LogEvent {
    /** 查询请求未通过输入校验。 */
    QueryRejected = 'query.rejected',
    /** 查询请求已受理。 */
    QueryReceived = 'query.received',
    /** 查询执行完成。 */
    QueryCompleted = 'query.completed',
    /** 查询执行失败。 */
    QueryFailed = 'query.failed',
    /** 结构查询未通过输入校验。 */
    SchemaRejected = 'schema.rejected',
    /** 结构查询已受理。 */
    SchemaReceived = 'schema.received',
    /** 结构查询执行完成。 */
    SchemaCompleted = 'schema.completed',
    /** 结构查询执行失败。 */
    SchemaFailed = 'schema.failed',
}
