export enum ErrorCode {
    ConfigError = 'CONFIG_ERROR',
    CredentialError = 'CREDENTIAL_ERROR',
    InvalidRequest = 'INVALID_REQUEST',
    SqlRejected = 'SQL_REJECTED',
    NotFound = 'NOT_FOUND',
    DatabaseError = 'DATABASE_ERROR',
    ReadOnlyRequired = 'READ_ONLY_REQUIRED',
    Timeout = 'TIMEOUT',
    ResultTooLarge = 'RESULT_TOO_LARGE',
    Busy = 'BUSY',
    Closed = 'CLOSED',
}
