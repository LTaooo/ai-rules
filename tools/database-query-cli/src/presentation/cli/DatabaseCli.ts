import { readFile } from 'node:fs/promises';
import { QueryService } from '../../application/QueryService.js';
import { InitWizard } from './InitWizard.js';
import { WindowsCredentialStore } from '../../infrastructure/credentials/WindowsCredentialStore.js';
import { StaticSourceRegistry } from '../../infrastructure/credentials/StaticSourceRegistry.js';
import { Logger } from '../../infrastructure/logging/Logger.js';
import { ErrorCode } from '../../domain/enums/ErrorCode.js';
import { SafeError } from '../../shared/errors/SafeError.js';
import type { Parameter } from '../../domain/models/QueryResult.js';

type Command = 'list' | 'describe' | 'query' | 'show' | 'init' | 'help';
type Options = {
    command: Command;
    database?: string;
    schema?: string;
    table?: string;
    tableLike?: string;
    sqlFile?: string;
    parametersFile?: string;
    parameters?: string;
    maxRows?: number;
    diagnose?: boolean;
};

/** 为人工、脚本与 agent 提供只读 SQL 查询的命令行入口。 */
export class DatabaseCli {
    /** 使用命令行参数创建 CLI，并复用 JSON 配置加载器。 */
    constructor(
        private readonly stdout: NodeJS.WritableStream = process.stdout,
        private readonly stderr: NodeJS.WritableStream = process.stderr,
        private readonly stdin: NodeJS.ReadableStream = process.stdin,
    ) {}

    /**
     * 解析参数、执行命令并返回适合进程退出的状态码。
     * @param args 命令行参数，默认取 process.argv 去掉前两项。
     * @returns 进程退出状态码：成功 0，安全失败 1。
     */
    public async run(args: string[] = process.argv.slice(2)): Promise<number> {
        let service: QueryService | undefined;
        let diagnose = false;
        try {
            const options = this.parse(args);
            diagnose = options.diagnose ?? false;
            if (options.command === 'help') {
                this.write(this.help());
                return 0;
            }
            if (options.command === 'init') {
                return await new InitWizard(this.stdin, this.stdout).run();
            }
            const registry =
                StaticSourceRegistry.tryFromEnvironment() ?? new WindowsCredentialStore();
            service = new QueryService(registry, undefined, undefined, new Logger(() => undefined));
            const result = await this.execute(options, service);
            await service.close();
            service = undefined;
            this.write(JSON.stringify(result));
            return 0;
        } catch (error) {
            const safe = SafeError.from(error);
            this.stderr.write(`${safe.code}\n`);
            if (diagnose && safe.diagnostic)
                this.stderr.write(`${JSON.stringify(safe.diagnostic)}\n`);
            return 1;
        } finally {
            try {
                await service?.close();
            } catch {
                // 主操作已经报告安全错误，清理失败不得泄露驱动异常或覆盖退出码。
            }
        }
    }

    /** 将命令参数转换为严格选项，拒绝未知、重复、缺值和越界参数。 */
    private parse(args: string[]): Options {
        if (args.length === 0 || args[0] === '--help' || args[0] === '-h')
            return { command: 'help' };
        const command = args[0];
        if (
            command !== 'list' &&
            command !== 'describe' &&
            command !== 'query' &&
            command !== 'show' &&
            command !== 'init'
        )
            throw new SafeError(ErrorCode.InvalidRequest);
        const options: Options = { command };
        const seen = new Set<string>();
        for (let index = 1; index < args.length; index += 1) {
            const flag = args[index];
            if (!flag?.startsWith('--') || seen.has(flag))
                throw new SafeError(ErrorCode.InvalidRequest);
            seen.add(flag);
            if (flag === '--diagnose') {
                options.diagnose = true;
                continue;
            }
            const value = args[++index];
            if (!value || value.startsWith('--')) throw new SafeError(ErrorCode.InvalidRequest);
            if (flag === '--database') options.database = value;
            else if (flag === '--schema') options.schema = value;
            else if (flag === '--table') options.table = value;
            else if (flag === '--table-like') options.tableLike = value;
            else if (flag === '--parameters') options.parameters = value;
            else if (flag === '--sql-file') options.sqlFile = value;
            else if (flag === '--parameters-file') options.parametersFile = value;
            else if (flag === '--max-rows') options.maxRows = this.positiveInteger(value);
            else throw new SafeError(ErrorCode.InvalidRequest);
        }
        this.validateOptions(options);
        return options;
    }

    /** 校验每个子命令所需参数，防止把不相关字段传入应用层。 */
    private validateOptions(options: Options): void {
        if (options.command === 'init') {
            if (
                options.database ||
                options.schema ||
                options.table ||
                options.tableLike ||
                options.sqlFile ||
                options.parametersFile ||
                options.parameters !== undefined ||
                options.maxRows !== undefined
            )
                throw new SafeError(ErrorCode.InvalidRequest);
            return;
        }
        if (options.command === 'show') {
            if (!options.database) throw new SafeError(ErrorCode.InvalidRequest);
            if (
                options.schema ||
                options.table ||
                options.tableLike ||
                options.sqlFile ||
                options.parametersFile ||
                options.parameters !== undefined ||
                options.maxRows !== undefined
            )
                throw new SafeError(ErrorCode.InvalidRequest);
            return;
        }
        if (options.command === 'list') {
            if (
                options.database ||
                options.schema ||
                options.table ||
                options.tableLike ||
                options.sqlFile ||
                options.parametersFile ||
                options.parameters !== undefined ||
                options.maxRows !== undefined
            )
                throw new SafeError(ErrorCode.InvalidRequest);
            return;
        }
        if (!options.database) throw new SafeError(ErrorCode.InvalidRequest);
        if (options.command === 'describe') {
            if (
                options.sqlFile ||
                options.parametersFile ||
                options.parameters !== undefined ||
                options.maxRows !== undefined
            )
                throw new SafeError(ErrorCode.InvalidRequest);
            return;
        }
        if (
            options.schema ||
            options.table ||
            options.tableLike ||
            (!options.sqlFile && options.parametersFile)
        )
            throw new SafeError(ErrorCode.InvalidRequest);
    }

    /** 执行公开列表、元数据查看、结构描述或参数绑定查询。 */
    private async execute(options: Options, service: QueryService): Promise<unknown> {
        if (options.command === 'list') return service.listDatabases();
        if (options.command === 'show') return service.showSource(options.database!);
        if (options.command === 'describe')
            return service.describe({
                database: options.database,
                schema: options.schema,
                table: options.table,
                tableLike: options.tableLike,
            });
        const sql = await this.readSql(options.sqlFile);
        const parameters = await this.readParameters(options);
        return service.query({
            database: options.database,
            sql,
            parameters,
            maxRows: options.maxRows,
        });
    }

    /** 读取 SQL 文件或标准输入，禁止将 SQL 拼接到日志或错误消息。 */
    private async readSql(filename: string | undefined): Promise<string> {
        const content = filename ? await this.readInput(filename) : await this.readInput('-');
        if (content.length === 0 || content.length > 65536)
            throw new SafeError(ErrorCode.InvalidRequest);
        return content;
    }

    /** 读取 JSON 参数数组并交给 QueryService 做最终类型和数量校验；支持文件与内联两种来源。 */
    private async readParameters(options: Options): Promise<Parameter[]> {
        if (options.parametersFile !== undefined) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(await this.readInput(options.parametersFile));
            } catch {
                throw new SafeError(ErrorCode.InvalidRequest);
            }
            return this.parameterArray(parsed);
        }
        if (options.parameters !== undefined) {
            let inline: unknown;
            try {
                inline = JSON.parse(options.parameters);
            } catch {
                throw new SafeError(ErrorCode.InvalidRequest);
            }
            return this.parameterArray(inline);
        }
        return [];
    }

    /** 校验参数数组形状，交给应用层做最终类型与数量限制。 */
    private parameterArray(parsed: unknown): Parameter[] {
        if (!Array.isArray(parsed)) throw new SafeError(ErrorCode.InvalidRequest);
        return parsed as Parameter[];
    }

    /** 从指定文件或 stdin 读取文本，不接受环境变量或命令替换。 */
    private async readInput(filename: string): Promise<string> {
        if (filename !== '-') return readFile(filename, 'utf8');
        const chunks: Buffer[] = [];
        for await (const chunk of this.stdin) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
    }

    /** 解析正整数限制并拒绝超出 JavaScript 安全范围的值。 */
    private positiveInteger(value: string): number {
        if (!/^\d+$/.test(value)) throw new SafeError(ErrorCode.InvalidRequest);
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1)
            throw new SafeError(ErrorCode.InvalidRequest);
        return number;
    }

    /** 输出单行 JSON，避免 CLI 日志污染机器可读结果。 */
    private write(value: string): void {
        this.stdout.write(`${value}\n`);
    }

    /** 返回简短用法说明，完整参数以 CLI --help 为准。 */
    private help(): string {
        return [
            'database-query CLI (read-only)',
            'Usage:',
            '  database-query list',
            '  database-query show --database NAME',
            '  database-query describe --database NAME [--schema NAME] [--table NAME|--table-like PATTERN]',
            '  database-query query --database NAME [--sql-file FILE|-] [--parameters-file FILE|--parameters JSON] [--max-rows N]',
            '  database-query init',
            'show prints source identification only; host, port and user are not shown.',
            'init runs an interactive wizard that creates or replaces a data source; it requires a TTY.',
            'SQL defaults to stdin; parameters must be a JSON array from a file or --parameters.',
            '--table-like does a contains match on table names; % and _ are SQL wildcards, * is translated to %.',
            'Values passed via --parameters appear on the command line; prefer files for sensitive values.',
            'Optional --diagnose adds only a safe MySQL stage and allowlisted error code to stderr.',
        ].join('\n');
    }
}
