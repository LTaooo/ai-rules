/** PostgreSQL 连接的 TLS 模式，映射到驱动连接参数。 */
export enum SslMode {
    /** 不加密，仅限受信任网络内使用。 */
    Disable = 'disable',
    /** 加密传输但不验证服务端证书。 */
    Require = 'require',
    /** 加密并验证服务端证书与信任链。 */
    VerifyFull = 'verify-full',
}
