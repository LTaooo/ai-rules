import * as p from '@clack/prompts';
import { CredentialFailure } from '../../domain/enums/CredentialFailure.js';
import { ErrorCode } from '../../domain/enums/ErrorCode.js';
import { DatabaseConfig } from '../../domain/models/DatabaseConfig.js';
import type { SourceRegistry } from '../../domain/ports/SourceRegistry.js';
import type { SourceRemover } from '../../domain/ports/SourceRemover.js';
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

export class EditWizard {
    /** 注入标准流、注册表、写入器、删除器与交互标志，测试可替换全部副作用。 */
    constructor(
        private readonly input: NodeJS.ReadableStream = process.stdin,
        private readonly output: NodeJS.WritableStream = process.stdout,
        private readonly registry: SourceRegistry = new WindowsCredentialStore(),
        private readonly writer: SourceWriter = new WindowsCredentialStore(),
        private readonly remover: SourceRemover = new WindowsCredentialStore(),
        private readonly interactive: boolean | undefined = undefined,
    ) {}

    /** 运行交互式编辑向导；非交互终端拒绝，取消静默返回。 */
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

    /** 驱动选择、编辑、确认、写入、读回验证与旧凭据删除。 */
    private async wizard(): Promise<void> {
        p.intro('database-query 数据源编辑向导');
        const { source, names } = await this.chooseSource();
        p.log.info(`当前别名: ${source.name}`);
        p.log.info(`当前类型: ${source.type}`);
        p.log.info(`当前描述: ${source.description ?? ''}`);
        const description = await this.askText(
            '用途描述',
            (value) => (value.length > 0 ? undefined : '不能为空'),
            source.description,
        );
        const name = await this.askName(source.name, names);
        if (name === source.name && description === source.description) {
            p.log.info('别名与描述均未变化，未写入任何数据');
            p.outro('未做修改');
            this.emitResult(name, false, false);
            return;
        }
        if (!(await this.confirmChange(source, name, description))) {
            p.cancel('已取消，未写入任何数据');
            throw new WizardCanceled();
        }
        await this.persist(source, name, description);
    }

    /** 列出数据源并让用户选择，随后重新读取该条目和当前别名集合。 */
    private async chooseSource(): Promise<{
        source: DatabaseConfig;
        names: ReadonlySet<string>;
    }> {
        const sources = await this.registry.list();
        if (sources.length === 0) {
            p.log.warn('没有已配置的数据源，请先运行 init');
            throw new SafeError(ErrorCode.NotFound);
        }
        const unique = new Map(sources.map((source) => [source.name, source]));
        const ordered = [...unique.values()].sort((left, right) =>
            left.name.localeCompare(right.name),
        );
        const selected = this.settled<string>(
            await p.select({
                message: '选择要编辑的数据源',
                options: ordered.map((source) => ({
                    value: source.name,
                    label: source.name,
                    hint: source.description ?? '',
                })),
            }),
        );
        return { source: await this.registry.get(selected), names: new Set(unique.keys()) };
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

    /** 询问新别名，预填当前值，拒绝非法、仅改大小写或与其他条目冲突的别名。 */
    private async askName(current: string, existing: ReadonlySet<string>): Promise<string> {
        const others = new Set(
            [...existing]
                .filter((name) => name.toLowerCase() !== current.toLowerCase())
                .map((name) => name.toLowerCase()),
        );
        for (;;) {
            const name = await this.askText(
                '数据源别名',
                (value) =>
                    SourceSchema.namePattern.test(value)
                        ? undefined
                        : '仅允许字母、数字、下划线与连字符，长度 1-128',
                current,
            );
            if (name === current) return name;
            if (name.toLowerCase() === current.toLowerCase()) {
                p.log.warn('Windows 凭据目标名不区分大小写，别名不能仅改变大小写');
                continue;
            }
            if (others.has(name.toLowerCase())) {
                p.log.warn(`别名「${name}」已被其他数据源使用，请换一个`);
                continue;
            }
            return name;
        }
    }

    /** 展示新旧别名与描述并请求确认，默认不保存。 */
    private async confirmChange(
        source: DatabaseConfig,
        name: string,
        description: string,
    ): Promise<boolean> {
        p.log.info(
            name === source.name ? `别名: ${source.name}` : `别名: ${source.name} -> ${name}`,
        );
        p.log.info(`描述: ${source.description ?? ''} -> ${description}`);
        return this.settled<boolean>(
            await p.confirm({
                message:
                    name === source.name
                        ? '保存以上修改？'
                        : `保存修改并将数据源重命名为「${name}」？`,
                initialValue: false,
            }),
        );
    }

    /** 写入、读回校验、按需删除旧目标，并输出单行 JSON 结果。 */
    private async persist(
        source: DatabaseConfig,
        name: string,
        description: string,
    ): Promise<void> {
        const renamed = name !== source.name;
        const oldTarget = SOURCE_TARGET_PREFIX + source.name;
        const target = SOURCE_TARGET_PREFIX + name;
        const expected = source.withNameAndDescription(name, description);
        const spinner = p.spinner();
        spinner.start(renamed ? '正在写入新凭据' : '正在写入凭据');
        try {
            await this.writer.write(target, JSON.stringify(expected));
        } catch (error) {
            spinner.stop('写入失败');
            throw error;
        }
        let verified: DatabaseConfig;
        try {
            verified = await this.registry.get(name);
        } catch (error) {
            spinner.stop('凭据读回校验失败');
            if (renamed) await this.removeQuietly(target);
            throw error;
        }
        if (!this.matches(verified, expected)) {
            spinner.stop('凭据读回校验不一致');
            if (renamed) await this.removeQuietly(target);
            throw SafeError.credential(CredentialFailure.Invalid);
        }
        spinner.stop('凭据已写入并可读回');
        if (renamed) {
            try {
                await this.remover.remove(oldTarget);
            } catch (error) {
                if (!(error instanceof SafeError && error.code === ErrorCode.NotFound)) {
                    p.log.warn(
                        `新数据源已写入并验证；旧凭据删除失败，请手动运行 cmdkey /delete:${oldTarget}`,
                    );
                    throw error;
                }
            }
        }
        p.outro(
            renamed
                ? `已重命名为「${name}」并保存到 Windows 凭据管理器`
                : '已保存到 Windows 凭据管理器',
        );
        this.emitResult(name, true, renamed);
    }

    /** 重命名校验失败时尽力删除新目标，不掩盖原始安全错误。 */
    private async removeQuietly(target: string): Promise<void> {
        try {
            await this.remover.remove(target);
        } catch {
            // 读回校验已经失败，回滚失败不改变对外错误码。
        }
    }

    /** 判断读回配置是否与预期别名、描述及全部连接字段一致。 */
    private matches(actual: DatabaseConfig, expected: DatabaseConfig): boolean {
        return (
            actual.name === expected.name &&
            actual.type === expected.type &&
            actual.description === expected.description &&
            actual.host === expected.host &&
            actual.port === expected.port &&
            actual.database === expected.database &&
            actual.username === expected.username &&
            actual.password === expected.password &&
            actual.filename === expected.filename &&
            actual.sslMode === expected.sslMode &&
            actual.tls === expected.tls
        );
    }

    /** 输出不含任何连接字段或密码的单行 JSON。 */
    private emitResult(name: string, changed: boolean, renamed: boolean): void {
        this.output.write(
            `${JSON.stringify({
                status: 'ok',
                database: name,
                target: SOURCE_TARGET_PREFIX + name,
                changed,
                renamed,
            })}\n`,
        );
    }
}
