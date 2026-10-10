import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseCli } from '../../../src/presentation/cli/DatabaseCli.js';
import { ConfigLoader } from '../../../src/infrastructure/config/ConfigLoader.js';
import { QueryService } from '../../../src/application/QueryService.js';
import { SafeError } from '../../../src/shared/errors/SafeError.js';
import { DatabaseStage } from '../../../src/domain/enums/DatabaseStage.js';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
    'exposes safe diagnostic fields only when requested (%s)',
    async (diagnose) => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        vi.spyOn(ConfigLoader.prototype, 'load').mockReturnValue({
            databases: [],
            limits: { maxRows: 10, timeoutMs: 1000, maxResponseBytes: 10000, maxConcurrency: 1 },
        });
        vi.spyOn(QueryService.prototype, 'describe').mockRejectedValue(
            SafeError.database(
                { code: 'ECONNREFUSED', message: 'synthetic private detail' },
                DatabaseStage.Connect,
            ),
        );
        const close = vi.spyOn(QueryService.prototype, 'close').mockResolvedValue(undefined);
        const args = ['describe', '--database', 'fake'];
        if (diagnose) args.push('--diagnose');
        expect(await new DatabaseCli(stdout, stderr).run(args)).toBe(1);
        expect(stdout.read()).toBeNull();
        expect(stderr.read()?.toString()).toBe(
            diagnose
                ? 'DATABASE_ERROR\n{"stage":"CONNECT","reason":"ECONNREFUSED"}\n'
                : 'DATABASE_ERROR\n',
        );
        expect(close).toHaveBeenCalledOnce();
    },
);

it('rejects query-only row limits on list before loading configuration', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const load = vi.spyOn(ConfigLoader.prototype, 'load');
    const status = await new DatabaseCli(stdout, stderr).run(['list', '--max-rows', '2']);
    expect(status).toBe(1);
    expect(load).not.toHaveBeenCalled();
    expect(stdout.read()).toBeNull();
    expect(stderr.read()?.toString()).toBe('INVALID_REQUEST\n');
});

it('sanitizes close failures without publishing a successful result', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    vi.spyOn(ConfigLoader.prototype, 'load').mockReturnValue({
        databases: [],
        limits: { maxRows: 10, timeoutMs: 1000, maxResponseBytes: 10000, maxConcurrency: 1 },
    });
    vi.spyOn(QueryService.prototype, 'close').mockRejectedValue(
        new Error('synthetic private driver detail'),
    );
    const status = await new DatabaseCli(stdout, stderr).run(['list']);
    expect(status).toBe(1);
    expect(stdout.read()).toBeNull();
    expect(stderr.read()?.toString()).toBe('DATABASE_ERROR\n');
});
