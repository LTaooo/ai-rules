import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SafeError } from '../../../src/shared/errors/SafeError.js';
import {
    SOURCE_TARGET_PREFIX,
    WindowsCredentialStore,
} from '../../../src/infrastructure/credentials/WindowsCredentialStore.js';
import type { ProcessSpawner } from '../../../src/infrastructure/credentials/ProcessSpawner.js';

class FakeChild extends EventEmitter {
    public stdout = new PassThrough();
    public stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    public kill = vi.fn();
}

function makeStore(child: FakeChild, timeoutMs = 20, maxOutputBytes = 65536) {
    const spawnMock = vi.fn(() => child);
    const store = new WindowsCredentialStore(
        spawnMock as unknown as ProcessSpawner,
        timeoutMs,
        maxOutputBytes,
    );
    return { store, spawnMock };
}

const sourceJson = JSON.stringify({
    name: 'sales',
    type: 'postgres',
    description: 'Synthetic',
    host: 'example.test',
    database: 'sales',
    username: 'reader',
    password: 'secret',
});

async function failure(pending: Promise<unknown>): Promise<SafeError> {
    try {
        await pending;
    } catch (error) {
        return error as SafeError;
    }
    throw new Error('expected rejection');
}

function flush(child: FakeChild, payload: string, code = 0): Promise<void> {
    child.stdout.write(payload);
    child.stdout.end();
    return new Promise((resolveTick) => setImmediate(resolveTick)).then(() => {
        child.emit('close', code);
    });
}

describe('Windows credential store', () => {
    it('reads and validates a source through stdin protocol without argv data', async () => {
        const child = new FakeChild();
        const { store, spawnMock } = makeStore(child);
        const pending = store.get('sales');
        expect(spawnMock).toHaveBeenCalledTimes(1);
        const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
            string,
            string[],
            { stdio: string[] },
        ];
        expect(command).toBe('powershell.exe');
        expect(args.join(' ')).not.toContain('database-query.sales');
        expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
        expect(child.stdin.end).toHaveBeenCalledWith(`read\n${SOURCE_TARGET_PREFIX}sales\n\n`);
        await flush(child, 'ok:' + Buffer.from(sourceJson, 'utf8').toString('base64'));
        const source = await pending;
        expect(source.password).toBe('secret');
        expect(source.name).toBe('sales');
    });

    it('maps a missing target to NotFound for reads', async () => {
        const child = new FakeChild();
        const { store } = makeStore(child);
        const pending = store.get('missing');
        await flush(child, 'err:1168');
        const error = await failure(pending);
        expect(error.code).toBe('NOT_FOUND');
    });

    it('rejects malformed blobs and invalid aliases as config errors', async () => {
        const child = new FakeChild();
        const { store } = makeStore(child);
        const pending = store.get('sales');
        await flush(child, 'ok:' + Buffer.from('not-json', 'utf8').toString('base64'));
        expect((await failure(pending)).code).toBe('CONFIG_ERROR');
        const badName = await failure(store.get('has space'));
        expect(badName.code).toBe('NOT_FOUND');
    });

    it('writes blobs with the target prefix and rejects foreign targets', async () => {
        const child = new FakeChild();
        const { store, spawnMock } = makeStore(child);
        const pending = store.write(`${SOURCE_TARGET_PREFIX}sales`, sourceJson);
        expect(child.stdin.end).toHaveBeenCalledWith(
            `write\n${SOURCE_TARGET_PREFIX}sales\n${Buffer.from(sourceJson, 'utf8').toString('base64')}\n`,
        );
        await flush(child, 'ok:e30=');
        await expect(pending).resolves.toBeUndefined();
        const foreign = await failure(store.write('other.junk', sourceJson));
        expect(foreign.code).toBe('CONFIG_ERROR');
        expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('lists and skips unparsable or foreign entries', async () => {
        const child = new FakeChild();
        const { store } = makeStore(child);
        const payload = Buffer.from(
            JSON.stringify([
                {
                    target: `${SOURCE_TARGET_PREFIX}sales`,
                    payload: Buffer.from(sourceJson, 'utf8').toString('base64'),
                },
                { target: `${SOURCE_TARGET_PREFIX}broken`, payload: 'aGFiYQ==' },
                {
                    target: 'other.junk',
                    payload: Buffer.from(sourceJson, 'utf8').toString('base64'),
                },
            ]),
            'utf8',
        ).toString('base64');
        const pending = store.list();
        await flush(child, 'ok:' + payload);
        const sources = await pending;
        expect(sources.map((source) => source.name)).toEqual(['sales']);
        expect(sources[0]?.password).toBe('secret');
    });

    it('treats an empty credential set as an empty list', async () => {
        const child = new FakeChild();
        const { store } = makeStore(child);
        const pending = store.list();
        await flush(child, 'ok:' + Buffer.from('[]', 'utf8').toString('base64'));
        expect(await pending).toEqual([]);
    });

    it('converts a missing target into NotFound at the registry layer', async () => {
        const child = new FakeChild();
        const { store } = makeStore(child);
        const pending = store.get('sales');
        await flush(child, 'err:1168');
        const error = await failure(pending);
        expect(error.code).toBe('NOT_FOUND');
    });

    it.each([
        ['err:5', 'ACCESS_DENIED'],
        ['err:EMPTY', 'INVALID'],
        ['err:999', 'PLATFORM'],
    ])('maps %s to a safe reason category', async (payload, reason) => {
        const child = new FakeChild();
        const { store } = makeStore(child);
        const pending = store.get('sales');
        await flush(child, payload);
        const error = await failure(pending);
        expect(error.code).toBe('CREDENTIAL_ERROR');
        expect(error.diagnostic?.reason).toBe(reason);
    });

    it('rejects with timeout and kills the child', async () => {
        vi.useFakeTimers();
        try {
            const child = new FakeChild();
            const { store } = makeStore(child, 20);
            const pending = store.get('sales');
            const expectation = expect(pending).rejects.toMatchObject({
                diagnostic: { reason: 'TIMEOUT' },
            });
            await vi.advanceTimersByTimeAsync(25);
            expect(child.kill).toHaveBeenCalled();
            await expectation;
        } finally {
            vi.useRealTimers();
        }
    });

    it('maps spawn errors and oversized output to safe failures', async () => {
        const child = new FakeChild();
        const spawnMock = vi.fn(() => {
            setTimeout(() => child.emit('error', new Error('ENOENT')), 0);
            return child;
        });
        const store = new WindowsCredentialStore(spawnMock as unknown as ProcessSpawner, 20);
        expect((await failure(store.get('sales'))).diagnostic?.reason).toBe('PLATFORM');
        const second = new FakeChild();
        const oversized = makeStore(second, 20, 10).store;
        const assertion = failure(oversized.get('sales'));
        second.stdout.write('ok:' + 'A'.repeat(100));
        expect((await assertion).diagnostic?.reason).toBe('INVALID');
        expect(second.kill).toHaveBeenCalled();
    });
});
