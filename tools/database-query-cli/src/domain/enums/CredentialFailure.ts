/** 凭据读取失败的安全原因类别，不包含系统消息、目标名或密钥内容。 */
export enum CredentialFailure {
    /** 凭据管理器中不存在目标条目。 */
    NotFound = 'NOT_FOUND',
    /** 操作系统拒绝读取凭据。 */
    AccessDenied = 'ACCESS_DENIED',
    /** 读取过程超过时间上限。 */
    Timeout = 'TIMEOUT',
    /** 凭据内容为空或不符合约定格式。 */
    Invalid = 'INVALID',
    /** 平台或系统调用层面的其他失败。 */
    Platform = 'PLATFORM',
}
