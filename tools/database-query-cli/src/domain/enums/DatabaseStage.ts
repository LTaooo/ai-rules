/** 数据库执行阶段的安全诊断标识，不包含连接信息或查询内容。 */
export enum DatabaseStage {
    /** 建立连接阶段。 */
    Connect = 'CONNECT',
    /** 服务器版本检查阶段，用于选择超时策略。 */
    VersionCheck = 'VERSION_CHECK',
    /** 只读事务与会话保护建立阶段。 */
    ReadOnly = 'READ_ONLY',
    /** 服务端执行时限设置阶段。 */
    Timeout = 'TIMEOUT_SETUP',
    /** 只读事务开启阶段。 */
    Begin = 'BEGIN',
    /** 业务查询执行阶段。 */
    Execute = 'EXECUTE',
    /** 回滚与资源释放阶段。 */
    Rollback = 'ROLLBACK',
}
