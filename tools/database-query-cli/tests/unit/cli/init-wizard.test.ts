import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { Dialect } from '../../../src/domain/enums/Dialect.js';
import { ErrorCode } from '../../../src/domain/enums/ErrorCode.js';
import { CredentialFailure } from '../../../src/domain/enums/CredentialFailure.js';
import { SafeError } from '../../../src/shared/errors/SafeError.js';
import { DatabaseConfig } from '../../../src/domain/models/DatabaseConfig.js';
import type { SourceRegistry } from '../../../src/domain/ports/SourceRegistry.js';
import type { SourceWriter } from '../../../src/domain/ports/SourceWriter.js';
import { InitWizard } from '../../../src/presentation/cli/InitWizard.js';

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
const salesOptions = {
    name: 'sales',
    type: Dialect.PostgreSQL,
    description: 'Synthetic',
    host: 'example.test',
    port: 5432,
    database: 'sales',
    username: 'reader',
    password: 'secret-value',
};
const salesConfig = new DatabaseConfig(salesOptions);

function makeWizard(overrides: { registry?: SourceRegistry; writer?: SourceWriter } = {}): {
    wizard: InitWizard;
    get: Mock;
    write: Mock<(target: string, payload: string) => Promise<void>>;
    out: { text: string };
} {
    const get = vi.fn(async () => {
        throw new SafeError(ErrorCode.NotFound);
    });
    const registry =
        overrides.registry ?? ({ get, list: vi.fn(async () => []) } satisfies SourceRegistry);
    const write = vi
        .fn<(target: string, payload: string) => Promise<void>>()
        .mockResolvedValue(undefined);
    const writer = overrides.writer ?? ({ write } satisfies SourceWriter);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = { text: '' };
    stdout.on('data', (chunk: Buffer) => {
        out.text += String(chunk);
    });
    const wizard = new InitWizard(stdin, stdout, registry, writer, true);
    return { wizard, get, write, out };
}

function queuePostgres() {
    prompts.select.mockResolvedValueOnce('postgres');
    for (const value of ['sales', 'Synthetic', 'db.example.test', '5432', 'salesdb', 'reader'])
        prompts.text.mockResolvedValueOnce(value);
    prompts.password.mockResolvedValueOnce('secret-value');
    prompts.select.mockResolvedValueOnce('require');
    prompts.confirm.mockResolvedValueOnce(true);
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('init wizard', () => {
    it('rejects non-interactive stdin before any prompt', async () => {
        makeWizard();
        const guarded = new InitWizard(
            new PassThrough(),
            new PassThrough(),
            { get: vi.fn(), list: vi.fn() },
            { write: vi.fn() },
        );
        await expect(guarded.run()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(prompts.text).not.toHaveBeenCalled();
    });

    it('writes the full configuration credential for postgres', async () => {
        const { wizard, get, write, out } = makeWizard();
        get.mockRejectedValueOnce(new SafeError(ErrorCode.NotFound));
        get.mockResolvedValueOnce(salesConfig);
        queuePostgres();
        const status = await wizard.run();
        expect(status).toBe(0);
        expect(write).toHaveBeenCalledTimes(1);
        const [target, payload] = write.mock.calls[0] as [string, string];
        expect(target).toBe('database-query.sales');
        expect(payload).toContain('"password":"secret-value"');
        expect(JSON.parse(payload).name).toBe('sales');
        expect(get).toHaveBeenCalledTimes(2);
        expect(out.text).toContain('"status":"ok"');
        expect(out.text).not.toContain('secret-value');
    });

    it('writes sqlite entries without a password', async () => {
        const { wizard, write, get } = makeWizard();
        const filename = resolve('.test-artifacts/fixture-local.sqlite');
        prompts.select.mockResolvedValueOnce('sqlite');
        prompts.text.mockResolvedValueOnce('local');
        prompts.text.mockResolvedValueOnce('Local fixture');
        prompts.text.mockResolvedValueOnce(filename);
        prompts.confirm.mockResolvedValueOnce(true);
        get.mockRejectedValueOnce(new SafeError(ErrorCode.NotFound));
        get.mockResolvedValueOnce(
            new DatabaseConfig({
                name: 'local',
                type: Dialect.SQLite,
                description: 'Local fixture',
                filename,
            }),
        );
        const status = await wizard.run();
        expect(status).toBe(0);
        const [target, payload] = write.mock.calls[0] as [string, string];
        expect(target).toBe('database-query.local');
        expect(JSON.parse(payload).filename).toBe(filename);
        expect(payload).not.toContain('password');
    });

    it('cancels silently without writing credentials', async () => {
        const { wizard, write } = makeWizard();
        prompts.select.mockResolvedValueOnce('postgres');
        prompts.text.mockResolvedValueOnce(CANCEL);
        const status = await wizard.run();
        expect(status).toBe(1);
        expect(write).not.toHaveBeenCalled();
        expect(prompts.cancel).toHaveBeenCalledWith('已取消，未写入任何数据');
    });

    it('asks again when the alias already exists and the user declines replacement', async () => {
        const { write } = makeWizard();
        const existing = new DatabaseConfig({ ...salesOptions });
        prompts.select.mockResolvedValueOnce('postgres');
        prompts.text.mockResolvedValueOnce('sales');
        prompts.confirm.mockResolvedValueOnce(false);
        prompts.text.mockResolvedValueOnce('sales2');
        prompts.text.mockResolvedValueOnce('Synthetic');
        prompts.text.mockResolvedValueOnce('db.example.test');
        prompts.text.mockResolvedValueOnce('5432');
        prompts.text.mockResolvedValueOnce('salesdb');
        prompts.text.mockResolvedValueOnce('reader');
        prompts.password.mockResolvedValueOnce('secret-value');
        prompts.select.mockResolvedValueOnce('require');
        prompts.confirm.mockResolvedValueOnce(true);
        const get = vi
            .fn()
            .mockResolvedValueOnce(existing)
            .mockRejectedValueOnce(new SafeError(ErrorCode.NotFound))
            .mockResolvedValueOnce(new DatabaseConfig({ ...salesOptions, name: 'sales2' }));
        const registry = { get, list: vi.fn(async () => []) } satisfies SourceRegistry;
        const wizard2 = new InitWizard(
            new PassThrough(),
            new PassThrough(),
            registry,
            { write },
            true,
        );
        const status = await wizard2.run();
        expect(status).toBe(0);
        const [target] = write.mock.calls[0] as [string, string];
        expect(target).toBe('database-query.sales2');
    });

    it('surfaces write failures without pretending success', async () => {
        const { wizard } = makeWizard({
            writer: {
                write: vi.fn().mockRejectedValue(SafeError.credential(CredentialFailure.Platform)),
            },
        });
        queuePostgres();
        await expect(wizard.run()).rejects.toMatchObject({
            code: 'CREDENTIAL_ERROR',
            diagnostic: { reason: 'PLATFORM' },
        });
        expect(prompts.outro).not.toHaveBeenCalled();
    });

    it('surfaces read-back mismatches as invalid credentials', async () => {
        const { wizard, get } = makeWizard();
        get.mockRejectedValueOnce(new SafeError(ErrorCode.NotFound));
        get.mockResolvedValueOnce(new DatabaseConfig({ ...salesOptions, password: 'tampered' }));
        queuePostgres();
        await expect(wizard.run()).rejects.toMatchObject({
            diagnostic: { reason: 'INVALID' },
        });
    });
});
