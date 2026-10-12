import { LogEvent } from '../../domain/enums/LogEvent.js';
import { LogLevel } from '../../domain/enums/LogLevel.js';

export type LogFields = Record<string, boolean | number | string | undefined>;
export type LogSink = (line: string) => void;

export class Logger {
    /** 保存注入的日志接收器；未注入时默认写进程 stderr。 */
    constructor(private readonly sink: LogSink = (line) => process.stderr.write(line)) {}

    /** 记录信息级事件，仅向注入的安全日志接收器写入。 */
    public info(event: LogEvent, fields?: LogFields): void {
        this.write(LogLevel.Info, event, fields);
    }

    /** 记录警告级事件，不记录 SQL 或查询数据。 */
    public warn(event: LogEvent, fields?: LogFields): void {
        this.write(LogLevel.Warn, event, fields);
    }

    /** 记录错误级事件，不记录原始异常或凭证。 */
    public error(event: LogEvent, fields?: LogFields): void {
        this.write(LogLevel.Error, event, fields);
    }

    /** 组装 JSON Lines 日志，脱敏敏感字段并写入 stderr 接收器。 */
    private write(level: LogLevel, event: LogEvent, fields?: LogFields): void {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            event,
            ...this.safeFields(fields),
        };
        this.sink(`${JSON.stringify(entry)}\n`);
    }

    /** 过滤敏感字段值，保留非敏感运行指标。 */
    private safeFields(fields: LogFields | undefined): LogFields {
        if (!fields) return {};
        return Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
                key,
                this.isSensitiveField(key) ? '[REDACTED]' : value,
            ]),
        );
    }

    /** 识别 SQL、用户名、凭证、参数、查询数据与路径字段，防止日志泄露。 */
    private isSensitiveField(key: string): boolean {
        const normalized = key.toLowerCase();
        return (
            normalized === 'sql' ||
            normalized.includes('username') ||
            normalized === 'user' ||
            normalized.includes('parameter') ||
            normalized.includes('password') ||
            normalized.includes('secret') ||
            normalized.includes('token') ||
            normalized.includes('credential') ||
            normalized.includes('connection') ||
            normalized.endsWith('url') ||
            normalized.includes('resultdata') ||
            normalized.endsWith('path') ||
            normalized.endsWith('file')
        );
    }
}
