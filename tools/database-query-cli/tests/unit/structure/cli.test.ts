import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseCli } from '../../../src/presentation/cli/DatabaseCli.js';
import { QueryService } from '../../../src/application/QueryService.js';
import { SafeError } from '../../../src/shared/errors/SafeError.js';
import { DatabaseStage } from '../../../src/domain/enums/DatabaseStage.js';

afterEach(() => vi.restoreAllMocks());

it('returns one sanitized JSON error with the available diagnosis by default', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    vi.spyOn(QueryService.prototype, 'describe').mockRejectedValue(
        SafeError.database(
            { code: 'ECONNREFUSED', message: 'synthetic private detail' },
            DatabaseStage.Connect,
        ),
    );
    const close = vi.spyOn(QueryService.prototype, 'close').mockResolvedValue(undefined);
    expect(await new DatabaseCli(stdout, stderr).run(['describe', '--database', 'fake'])).toBe(1);
    expect(stdout.read()).toBeNull();
    const lines = stderr.read().toString().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    expect(JSON.parse(lines[0]!)).toEqual({
        ok: false,
        result: {
            code: 'DATABASE_ERROR',
            diagnostic: { stage: 'CONNECT', reason: 'ECONNREFUSED' },
        },
    });
    expect(close).toHaveBeenCalledOnce();
});

it.each([['--max-rows', '2'], ['--diagnose']])(
    'rejects unsupported list options %j',
    async (...args) => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const status = await new DatabaseCli(stdout, stderr).run(['list', ...args]);
        expect(status).toBe(1);
        expect(stdout.read()).toBeNull();
        expect(JSON.parse(stderr.read().toString())).toMatchObject({
            ok: false,
            result: { code: 'INVALID_REQUEST' },
        });
    },
);

it('sanitizes close failures without publishing a successful result', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    vi.spyOn(QueryService.prototype, 'listDatabases').mockResolvedValue([]);
    vi.spyOn(QueryService.prototype, 'close').mockRejectedValue(
        new Error('synthetic private driver detail'),
    );
    const status = await new DatabaseCli(stdout, stderr).run(['list']);
    expect(status).toBe(1);
    expect(stdout.read()).toBeNull();
    expect(JSON.parse(stderr.read().toString())).toEqual({
        ok: false,
        result: { code: 'DATABASE_ERROR' },
    });
});
