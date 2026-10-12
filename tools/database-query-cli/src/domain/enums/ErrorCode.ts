/** 面向调用方的安全错误码集合，一切对外输出只使用这些值。 */
export enum ErrorCode {
    /** 数据源凭据内容缺失或不合法。 */
    ConfigError = 'CONFIG_ERROR',
    /** 凭据读取或写入失败，原因见诊断类别。 */
    CredentialError = 'CREDENTIAL_ERROR',
    /** 输入参数、占位符或限额不合法。 */
    InvalidRequest = 'INVALID_REQUEST',
    /** SQL 不在只读许可范围内。 */
    SqlRejected = 'SQL_REJECTED',
    /** 数据源别名或指定表不可见或不存在。 */
    NotFound = 'NOT_FOUND',
    /** 连接、认证或执行失败，详细信息被隐藏。 */
    DatabaseError = 'DATABASE_ERROR',
    /** 只读保护无法建立或账户权限过高。 */
    ReadOnlyRequired = 'READ_ONLY_REQUIRED',
    /** 超过执行时间上限。 */
    Timeout = 'TIMEOUT',
    /** 响应或字段超出大小限制。 */
    ResultTooLarge = 'RESULT_TOO_LARGE',
    /** 数据源并发达到上限。 */
    Busy = 'BUSY',
    /** 服务已关闭或正在关闭。 */
    Closed = 'CLOSED',
}
