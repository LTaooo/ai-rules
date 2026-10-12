import { isAbsolute } from 'node:path';
import * as p from '@clack/prompts';
import { CredentialFailure } from '../../domain/enums/CredentialFailure.js';
import { Dialect } from '../../domain/enums/Dialect.js';
import { SslMode } from '../../domain/enums/SslMode.js';
import { ErrorCode } from '../../domain/enums/ErrorCode.js';
import { DatabaseConfig } from '../../domain/models/DatabaseConfig.js';
import type { SourceRegistry } from '../../domain/ports/SourceRegistry.js';
import type { SourceWriter } from '../../domain/ports/SourceWriter.js';
import {
    SOURCE_TARGET_PREFIX,
    WindowsCredentialStore,
} from '../../infrastructure/credentials/WindowsCredentialStore.js';
import { SourceSchema } from '../../infrastructure/config/SourceSchema.js';
import { SafeError } from '../../shared/errors/SafeError.js';

/** 用户主动取消向导的内部信号，静默结束且不写入任何数据。 */
class WizardCanceled extends Error {
    /** 仅标记取消状态，不携带任何敏感信息。 */
    constructor() {
        super('wizard canceled');
        this.name = 'WizardCanceled';
    }
}

export class InitWizard {
    /** 注入标准流、数据源注册表与凭据写入器，测试可替换全部副作用。 */
    constructor(
        private readonly input: NodeJS.ReadableStream = process.stdin,
        private readonly output: NodeJS.WritableStream = process.stdout,
        private readonly registry: SourceRegistry = new WindowsCredentialStore(),
        private readonly writer: SourceWriter = new WindowsCredentialStore(),
        private readonly interactive: boolean | undefined = undefined,
    ) {}

    /** 运行交互式配置向导；非交互终端直接拒绝，取消静默返回，其余异常沿用安全错误。 */
    public async run(): Promise<number> {
        if (
            this.interactive === false ||
            (this.interactive === undefined && (this.input as { isTTY?: boolean }).isTTY !== true)
        ) {
            throw new SafeError(ErrorCode.InvalidRequest);
        }
        try {
            await this.wizard();
            return 0;
        } catch (error) {
            if (error instanceof WizardCanceled) return 1;
            if (error instanceof SafeError && error.diagnostic?.reason) {
                p.log.error(`操作失败（${error.code}）：${error.diagnostic.reason}`);
            }
            throw error;
        }
    }

    /** 驱动完整向导流程：询问、确认、写入凭据管理器并读回验证。 */
    private async wizard(): Promise<void> {
        p.intro('database-query 配置向导');
        const dialect = await this.askDialect();
        const entry =
            dialect === Dialect.SQLite ? await this.sqliteEntry() : await this.remoteEntry(dialect);
        if (!(await this.confirmEntry(entry))) {
            p.cancel('已取消，未写入任何数据');
            throw new WizardCanceled();
        }
        const target = SOURCE_TARGET_PREFIX + entry.name;
        await this.writer.write(target, JSON.stringify(entry));
        const spinner = p.spinner();
        spinner.start('正在验证凭据可读性');
        const verified = await this.registry.get(entry.name);
        if (
            verified.name !== entry.name ||
            (entry.password !== undefined && verified.password !== entry.password)
        ) {
            spinner.stop('凭据读回校验不一致');
            throw SafeError.credential(CredentialFailure.Invalid);
        }
        spinner.stop('凭据已写入并可读回');
        p.outro(`已保存到 Windows 凭据管理器：${target}`);
        this.output.write(`${JSON.stringify({ status: 'ok', database: entry.name, target })}\n`);
    }

    /** 将取消符号转换为静默退出，其余值原样返回。 */
    private settled<T>(value: T | symbol): T {
        if (p.isCancel(value)) {
            p.cancel('已取消，未写入任何数据');
            throw new WizardCanceled();
        }
        return value as T;
    }

    /** 询问文本字段，支持默认值与就地校验重问。 */
    private async askText(
        message: string,
        validate: (value: string) => string | undefined,
        initialValue?: string,
    ): Promise<string> {
        return this.settled<string>(
            await p.text({
                message,
                ...(initialValue !== undefined ? { initialValue } : {}),
                validate: (value: string | undefined) => validate(value ?? ''),
            }),
        );
    }

    /** 询问必填非空文本字段。 */
    private async askRequired(message: string): Promise<string> {
        return this.askText(message, (value: string) =>
            value.length > 0 ? undefined : '不能为空',
        );
    }

    /** 询问不回显的数据库密码，长度限制与凭据校验一致。 */
    private async askPassword(): Promise<string> {
        return this.settled<string>(
            await p.password({
                message: '数据库密码（不回显，仅写入 Windows 凭据管理器）',
                validate: (value: string | undefined) =>
                    value !== undefined && value.length >= 1 && value.length <= 1024
                        ? undefined
                        : '密码长度需为 1-1024 个字符',
            }),
        );
    }

    /** 询问数据源别名；与既有条目同名时确认替换或重新命名。 */
    private async askName(): Promise<string> {
        for (;;) {
            const name = await this.askText('数据源别名', (value: string) =>
                SourceSchema.namePattern.test(value)
                    ? undefined
                    : '仅允许字母、数字、下划线与连字符，长度 1-128',
            );
            let exists: boolean;
            try {
                await this.registry.get(name);
                exists = true;
            } catch {
                exists = false;
            }
            if (!exists) return name;
            const replace = this.settled<boolean>(
                await p.confirm({
                    message: `同名数据源「${name}」已存在，替换它？`,
                    initialValue: false,
                }),
            );
            if (replace) return name;
        }
    }

    /** 询问端口，提供方言默认值并限制 1-65535。 */
    private async askPort(defaultPort: number): Promise<number> {
        const value = await this.askText(
            '端口',
            (input: string) =>
                /^\d+$/.test(input) &&
                Number.isSafeInteger(Number(input)) &&
                Number(input) >= 1 &&
                Number(input) <= 65535
                    ? undefined
                    : '端口需为 1-65535 的整数',
            String(defaultPort),
        );
        return Number(value);
    }

    /** 选择 PostgreSQL TLS 模式，默认要求加密。 */
    private async askSslMode(): Promise<SslMode> {
        return this.settled<SslMode>(
            await p.select({
                message: 'TLS 模式',
                initialValue: SslMode.Require,
                options: [
                    { value: SslMode.Disable, label: 'disable', hint: '不加密，仅限受信任网络' },
                    { value: SslMode.Require, label: 'require', hint: '加密但不验证服务端证书' },
                    {
                        value: SslMode.VerifyFull,
                        label: 'verify-full',
                        hint: '加密并验证服务端证书',
                    },
                ],
            }),
        );
    }

    /** 选择数据源类型，附说明帮助选择。 */
    private async askDialect(): Promise<Dialect> {
        return this.settled<Dialect>(
            await p.select({
                message: '数据源类型',
                options: [
                    {
                        value: Dialect.PostgreSQL,
                        label: 'postgres',
                        hint: 'PostgreSQL，配置与密码存 Windows 凭据管理器',
                    },
                    {
                        value: Dialect.MySQL,
                        label: 'mysql',
                        hint: 'MySQL，配置与密码存 Windows 凭据管理器',
                    },
                    { value: Dialect.SQLite, label: 'sqlite', hint: '本地文件，无需密码' },
                ],
            }),
        );
    }

    /** 询问 SQLite 数据源：文件必须是绝对路径且不允许内存库。 */
    private async sqliteEntry(): Promise<DatabaseConfig> {
        const name = await this.askName();
        const description = await this.askRequired('用途描述');
        const filename = await this.askText('数据库文件绝对路径', (value: string) =>
            isAbsolute(value) && !value.includes(':memory:')
                ? undefined
                : '必须是绝对路径且不是内存数据库',
        );
        return SourceSchema.validateDatabase({ name, type: Dialect.SQLite, description, filename });
    }

    /** 询问远程数据源完整字段并组装经验证的配置。 */
    private async remoteEntry(dialect: Dialect): Promise<DatabaseConfig> {
        const name = await this.askName();
        const description = await this.askRequired('用途描述');
        const host = await this.askRequired('主机地址');
        const port = await this.askPort(dialect === Dialect.PostgreSQL ? 5432 : 3306);
        const database = await this.askText('数据库名', (value: string) =>
            value.length > 0 && !value.includes('/') ? undefined : '不能为空且不可包含 /',
        );
        const username = await this.askRequired('登录用户名');
        const password = await this.askPassword();
        const raw = {
            name,
            type: dialect,
            description,
            host,
            port,
            database,
            username,
            password,
        } as Record<string, unknown>;
        if (dialect === Dialect.PostgreSQL) {
            raw.sslMode = await this.askSslMode();
        } else {
            raw.tls = this.settled<boolean>(
                await p.confirm({ message: '启用 TLS 连接？', initialValue: false }),
            );
        }
        return SourceSchema.validateDatabase(raw);
    }

    /** 展示除密码外的摘要并请求确认，默认不写入。 */
    private async confirmEntry(entry: DatabaseConfig): Promise<boolean> {
        for (const [key, value] of Object.entries(entry)) {
            if (key === 'password' || value === undefined) continue;
            p.log.info(`${key}: ${String(value)}`);
        }
        return this.settled<boolean>(
            await p.confirm({
                message: '按以上内容写入 Windows 凭据管理器？',
                initialValue: false,
            }),
        );
    }
}
