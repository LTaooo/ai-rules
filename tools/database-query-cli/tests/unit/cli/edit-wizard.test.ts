import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialFailure } from '../../../src/domain/enums/CredentialFailure.js';
import { Dialect } from '../../../src/domain/enums/Dialect.js';
import { ErrorCode } from '../../../src/domain/enums/ErrorCode.js';
import { SslMode } from '../../../src/domain/enums/SslMode.js';
import { DatabaseConfig } from '../../../src/domain/models/DatabaseConfig.js';
import type { SourceRegistry } from '../../../src/domain/ports/SourceRegistry.js';
import type { SourceRemover } from '../../../src/domain/ports/SourceRemover.js';
import type { SourceWriter } from '../../../src/domain/ports/SourceWriter.js';
import { SourceSchema } from '../../../src/infrastructure/config/SourceSchema.js';
import { EditWizard } from '../../../src/presentation/cli/EditWizard.js';
import { SafeError } from '../../../src/shared/errors/SafeError.js';

const prompts = vi.hoisted(() => ({
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), message: vi.fn(), error: vi.fn() },
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    isCancel: vi.fn(
        (value: unknown) => typeof value === 'symbol' && value.description === 'clack:cancel',
    ),
    select: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    confirm: vi.fn(),
}));

vi.mock('@clack/prompts', () => prompts);

const CANCEL = Symbol('clack:cancel');
const TARGET_PREFIX = 'database-query.';

function remoteConfig(name = 'sales', description = 'Synthetic'): DatabaseConfig {
    return new DatabaseConfig({
        name,
        type: Dialect.PostgreSQL,
        description,
        host: 'example.test',
        port: 5432,
        database: 'sales',
        username: 'reader',
        password: 'secret-value',
        sslMode: SslMode.Require,
    });
}

function makeWizard(options: { sources?: DatabaseConfig[] } = {}) {
    const store = new Map<string, DatabaseConfig>();
    for (const source of options.sources ?? [remoteConfig()]) store.set(source.name, source);
    const list = vi.fn(async () => [...store.values()]);
    const get = vi.fn(async (name: string) => {
        const found = store.get(name);
        if (!found) throw new SafeError(ErrorCode.NotFound);
        return found;
    });
    const write = vi.fn(async (target: string, payload: string) => {
        const name = target.slice(TARGET_PREFIX.length);
        store.set(name, SourceSchema.validateDatabase(JSON.parse(payload) as unknown));
    });
    const remove = vi.fn(async (target: string) => {
        if (!store.delete(target.slice(TARGET_PREFIX.length)))
            throw new SafeError(ErrorCode.NotFound);
    });
    const stdout = new PassThrough();
    const out = { text: '' };
    stdout.on('data', (chunk: Buffer) => {
        out.text += String(chunk);
    });
    const wizard = new EditWizard(
        new PassThrough(),
        stdout,
        { list, get } satisfies SourceRegistry,
        { write } satisfies SourceWriter,
        { remove } satisfies SourceRemover,
        true,
    );
    return { wizard, store, list, get, write, remove, out };
}

function queue(select: string, description: string, name: string, confirm = true): void {
    prompts.select.mockResolvedValueOnce(select);
    prompts.text.mockResolvedValueOnce(description);
    prompts.text.mockResolvedValueOnce(name);
    prompts.confirm.mockResolvedValueOnce(confirm);
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('edit wizard', () => {
    it('rejects non-interactive stdin before listing or prompting', async () => {
        const list = vi.fn(async () => [] as DatabaseConfig[]);
        const wizard = new EditWizard(
            new PassThrough(),
            new PassThrough(),
            { list, get: vi.fn() } satisfies SourceRegistry,
            { write: vi.fn() } satisfies SourceWriter,
            { remove: vi.fn() } satisfies SourceRemover,
        );
        await expect(wizard.run()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(list).not.toHaveBeenCalled();
        expect(prompts.select).not.toHaveBeenCalled();
    });

    it('reports NotFound when no sources are configured', async () => {
        const { wizard, store } = makeWizard({ sources: [] });
        await expect(wizard.run()).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(prompts.select).not.toHaveBeenCalled();
        expect(store.size).toBe(0);
    });

    it('offers only alias, description and type, never connection details', async () => {
        const { wizard } = makeWizard();
        queue('sales', 'Updated', 'sales');
        await wizard.run();
        const select = prompts.select.mock.calls[0]?.[0] as {
            options: { value: string; label: string; hint: string }[];
        };
        expect(select.options).toEqual([{ value: 'sales', label: 'sales', hint: 'Synthetic' }]);
        expect(JSON.stringify(select)).not.toContain('secret-value');
        expect(JSON.stringify(select)).not.toContain('example.test');
    });

    it('updates only the description and preserves the password', async () => {
        const { wizard, write, remove, out } = makeWizard();
        queue('sales', 'Updated', 'sales');
        expect(await wizard.run()).toBe(0);
        expect(write).toHaveBeenCalledTimes(1);
        const [target, payload] = write.mock.calls[0] as [string, string];
        expect(target).toBe(`${TARGET_PREFIX}sales`);
        const written = JSON.parse(payload);
        expect(written.description).toBe('Updated');
        expect(written.password).toBe('secret-value');
        expect(remove).not.toHaveBeenCalled();
        expect(out.text).toContain('"changed":true');
        expect(out.text).toContain('"renamed":false');
        expect(out.text).not.toContain('secret-value');
    });

    it('renames by writing and verifying the new target before removing the old one', async () => {
        const { wizard, store, get, write, remove, out } = makeWizard();
        queue('sales', 'Synthetic', 'finance');
        expect(await wizard.run()).toBe(0);
        const [target, payload] = write.mock.calls[0] as [string, string];
        expect(target).toBe(`${TARGET_PREFIX}finance`);
        expect(JSON.parse(payload).name).toBe('finance');
        expect(JSON.parse(payload).password).toBe('secret-value');
        expect(remove).toHaveBeenCalledWith(`${TARGET_PREFIX}sales`);
        expect(write.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[1]!);
        expect(get.mock.invocationCallOrder[1]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
        expect([...store.keys()]).toEqual(['finance']);
        expect(out.text).toContain('"renamed":true');
    });

    it('applies description and alias changes together', async () => {
        const { wizard, out } = makeWizard();
        queue('sales', 'Updated', 'finance');
        expect(await wizard.run()).toBe(0);
        expect(out.text).toContain('"changed":true');
        expect(out.text).toContain('"renamed":true');
    });

    it('re-prompts when the new alias belongs to another source', async () => {
        const { wizard, write } = makeWizard({
            sources: [remoteConfig(), remoteConfig('other', 'Other source')],
        });
        prompts.select.mockResolvedValueOnce('sales');
        prompts.text.mockResolvedValueOnce('Updated');
        prompts.text.mockResolvedValueOnce('other');
        prompts.text.mockResolvedValueOnce('finance');
        prompts.confirm.mockResolvedValueOnce(true);
        expect(await wizard.run()).toBe(0);
        expect(prompts.log.warn).toHaveBeenCalledWith(
            expect.stringContaining('已被其他数据源使用'),
        );
        expect(write).toHaveBeenCalledTimes(1);
        expect((write.mock.calls[0] as [string, string])[0]).toBe(`${TARGET_PREFIX}finance`);
    });

    it('re-prompts when the alias only changes letter case', async () => {
        const { wizard, write } = makeWizard();
        prompts.select.mockResolvedValueOnce('sales');
        prompts.text.mockResolvedValueOnce('Updated');
        prompts.text.mockResolvedValueOnce('SALES');
        prompts.text.mockResolvedValueOnce('finance');
        prompts.confirm.mockResolvedValueOnce(true);
        expect(await wizard.run()).toBe(0);
        expect(prompts.log.warn).toHaveBeenCalledWith(expect.stringContaining('不区分大小写'));
        expect((write.mock.calls[0] as [string, string])[0]).toBe(`${TARGET_PREFIX}finance`);
    });

    it('does nothing when both values are unchanged', async () => {
        const { wizard, write, remove, out } = makeWizard();
        prompts.select.mockResolvedValueOnce('sales');
        prompts.text.mockResolvedValueOnce('Synthetic');
        prompts.text.mockResolvedValueOnce('sales');
        expect(await wizard.run()).toBe(0);
        expect(prompts.confirm).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(out.text).toContain('"changed":false');
        expect(prompts.outro).toHaveBeenCalledWith('未做修改');
    });

    it('cancels without writing when confirmation is declined', async () => {
        const { wizard, write, remove } = makeWizard();
        queue('sales', 'Updated', 'finance', false);
        expect(await wizard.run()).toBe(1);
        expect(write).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(prompts.cancel).toHaveBeenCalledWith('已取消，未写入任何数据');
    });

    it('cancels without writing when the source selection is canceled', async () => {
        const { wizard, write } = makeWizard();
        prompts.select.mockResolvedValueOnce(CANCEL);
        expect(await wizard.run()).toBe(1);
        expect(write).not.toHaveBeenCalled();
    });

    it('propagates write failures without deleting anything', async () => {
        const { wizard, write, remove, out } = makeWizard();
        write.mockRejectedValueOnce(new SafeError(ErrorCode.CredentialError));
        queue('sales', 'Updated', 'finance');
        await expect(wizard.run()).rejects.toMatchObject({ code: 'CREDENTIAL_ERROR' });
        expect(remove).not.toHaveBeenCalled();
        expect(out.text).toBe('');
    });

    it('rolls back a renamed target when read-back verification mismatches', async () => {
        const { wizard, get, remove, store } = makeWizard();
        const original = store.get('sales')!;
        get.mockResolvedValueOnce(original);
        get.mockResolvedValueOnce(
            new DatabaseConfig({ ...original, name: 'finance', password: 'tampered' }),
        );
        queue('sales', 'Synthetic', 'finance');
        await expect(wizard.run()).rejects.toMatchObject({
            code: 'CREDENTIAL_ERROR',
            diagnostic: { reason: 'INVALID' },
        });
        expect(remove).toHaveBeenCalledWith(`${TARGET_PREFIX}finance`);
        expect(remove).not.toHaveBeenCalledWith(`${TARGET_PREFIX}sales`);
        expect(store.has('sales')).toBe(true);
    });

    it('reports a partial rename when the old credential cannot be deleted', async () => {
        const { wizard, remove, store, out } = makeWizard();
        remove.mockRejectedValueOnce(SafeError.credential(CredentialFailure.AccessDenied));
        queue('sales', 'Synthetic', 'finance');
        await expect(wizard.run()).rejects.toMatchObject({ code: 'CREDENTIAL_ERROR' });
        expect(prompts.log.warn).toHaveBeenCalledWith(
            expect.stringContaining(`cmdkey /delete:${TARGET_PREFIX}sales`),
        );
        expect([...store.keys()].sort()).toEqual(['finance', 'sales']);
        expect(out.text).toBe('');
    });

    it('treats a missing old credential as an idempotent rename', async () => {
        const { wizard, remove, out } = makeWizard();
        remove.mockRejectedValueOnce(new SafeError(ErrorCode.NotFound));
        queue('sales', 'Synthetic', 'finance');
        expect(await wizard.run()).toBe(0);
        expect(out.text).toContain('"renamed":true');
    });

    it('renames sqlite sources without adding a password field', async () => {
        const filename = resolve('.test-artifacts/fixture-local.sqlite');
        const sqlite = new DatabaseConfig({
            name: 'local',
            type: Dialect.SQLite,
            description: 'Local fixture',
            filename,
        });
        const { wizard, write, remove } = makeWizard({ sources: [sqlite] });
        queue('local', 'Moved fixture', 'local2');
        expect(await wizard.run()).toBe(0);
        const [target, payload] = write.mock.calls[0] as [string, string];
        expect(target).toBe(`${TARGET_PREFIX}local2`);
        const written = JSON.parse(payload);
        expect(written.password).toBeUndefined();
        expect(written.filename).toBe(filename);
        expect(written.description).toBe('Moved fixture');
        expect(remove).toHaveBeenCalledWith(`${TARGET_PREFIX}local`);
    });
});
