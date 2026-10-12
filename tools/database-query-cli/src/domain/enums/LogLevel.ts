/** 日志严重级别，决定 stderr 日志行的 level 字段取值。 */
export enum LogLevel {
    /** 正常流转信息。 */
    Info = 'info',
    /** 不影响退出码但值得注意的状态。 */
    Warn = 'warn',
    /** 需要关注的失败状态。 */
    Error = 'error',
}
