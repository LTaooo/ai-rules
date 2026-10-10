import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfigLoader } from '../infrastructure/config/ConfigLoader.js';
import { Logger } from '../infrastructure/logging/Logger.js';
import { SafeError } from '../shared/errors/SafeError.js';
import { DatabaseMcpServer } from '../presentation/mcp/DatabaseMcpServer.js';
import { QueryService } from '../application/QueryService.js';
import { ErrorCode } from '../domain/enums/ErrorCode.js';
import { LogEvent } from '../domain/enums/LogEvent.js';

export class Application {
    private service: QueryService | undefined;
    private server: McpServer | undefined;
    private stopping: Promise<void> | undefined;
    /** 注入只写 stderr 的日志器，启动前不建立任何数据库连接。 */
    constructor(private readonly logger: Logger = new Logger()) {}
    /** 加载显式 JSON 配置、连接 stdio 并安装进程生命周期处理。 */
    public async run(): Promise<void> {
        const config = ConfigLoader.fromArguments().load();
        this.logger.info(LogEvent.ServerStarting, {
            databaseCount: config.databases.length,
            databaseTypes: [...new Set(config.databases.map((database) => database.type))].join(
                ',',
            ),
        });
        this.service = new QueryService(config, undefined, this.logger);
        this.server = DatabaseMcpServer.create(this.service);
        process.once('SIGINT', this.stop);
        process.once('SIGTERM', this.stop);
        process.once('uncaughtException', this.uncaughtException);
        process.once('unhandledRejection', this.unhandledRejection);
        this.server.server.onclose = this.stop;
        try {
            await this.server.connect(new StdioServerTransport());
            this.logger.info(LogEvent.ServerStarted);
        } catch (error) {
            await this.shutdown();
            throw error;
        }
    }
    /** 缓存关闭 Promise，确保重复信号只执行一次资源释放。 */
    public shutdown(): Promise<void> {
        this.stopping ??= this.close();
        return this.stopping;
    }
    /** 即使适配器关闭失败也关闭协议连接，并移除已安装的监听器。 */
    private async close(): Promise<void> {
        this.logger.info(LogEvent.ServerStopping);
        try {
            await this.service?.close();
        } finally {
            await this.server?.close();
            process.removeListener('SIGINT', this.stop);
            process.removeListener('SIGTERM', this.stop);
            process.removeListener('uncaughtException', this.uncaughtException);
            process.removeListener('unhandledRejection', this.unhandledRejection);
        }
        this.logger.info(LogEvent.ServerStopped);
    }
    /** 将信号或连接关闭转换为异步幂等关闭，失败仅设置退出码。 */
    private readonly stop = (): void => {
        void this.shutdown().catch(() => {
            process.exitCode = 1;
        });
    };
    /** 脱敏处理未捕获异常，不记录异常文本或堆栈。 */
    private readonly uncaughtException = (): void => {
        this.logger.error(LogEvent.ServerUncaughtException, { code: ErrorCode.DatabaseError });
        process.exitCode = 1;
        this.stop();
    };
    /** 脱敏处理未处理的 Promise 拒绝并停止服务。 */
    private readonly unhandledRejection = (): void => {
        this.logger.error(LogEvent.ServerUnhandledRejection, { code: ErrorCode.DatabaseError });
        process.exitCode = 1;
        this.stop();
    };
    /** 报告启动安全错误并设置失败退出码，不暴露配置内容。 */
    public static failure(error: unknown): void {
        new Logger().error(LogEvent.ServerStartFailed, { code: SafeError.from(error).code });
        process.exitCode = 1;
    }
}
