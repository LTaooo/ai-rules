/** 凭据读取失败的安全原因类别，不包含系统消息、目标名或密钥内容。 */
export enum CredentialFailure {
    NotFound = 'NOT_FOUND',
    AccessDenied = 'ACCESS_DENIED',
    Timeout = 'TIMEOUT',
    Invalid = 'INVALID',
    Platform = 'PLATFORM',
}
