export interface SourceWriter {
    /** 将数据源完整配置 JSON 写入凭据管理器目标；明文不落盘、不进日志、不进命令行。 */
    write(target: string, payload: string): Promise<void>;
}
