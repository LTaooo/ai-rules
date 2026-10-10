/** 数据库执行阶段的安全诊断标识，不包含连接信息或查询内容。 */
export enum DatabaseStage {
    Connect = 'CONNECT',
    VersionCheck = 'VERSION_CHECK',
    ReadOnly = 'READ_ONLY',
    Timeout = 'TIMEOUT_SETUP',
    Begin = 'BEGIN',
    Execute = 'EXECUTE',
    Rollback = 'ROLLBACK',
}
