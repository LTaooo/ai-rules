import { describe, expect, it, vi } from 'vitest';
import { Dialect } from '../../../src/domain/enums/Dialect.js';
import { ErrorCode } from '../../../src/domain/enums/ErrorCode.js';
import { SafeError } from '../../../src/shared/errors/SafeError.js';
import { Logger } from '../../../src/infrastructure/logging/Logger.js';
import { QueryService } from '../../../src/application/QueryService.js';
import { SourceSchema } from '../../../src/infrastructure/config/SourceSchema.js';
import { DatabaseConfig } from '../../../src/domain/models/DatabaseConfig.js';
import type { SourceRegistry } from '../../../src/domain/ports/SourceRegistry.js';

function makeAdapter(rows: unknown[][] = [[1]]) {
    return {
        query: vi.fn().mockResolvedValue({ columns: ['id'], rows }),
        describe: vi.fn().mockResolvedValue({ columns: ['table_name'], rows: [['users']] }),
        close: vi.fn().mockResolvedValue(undefined),
    };
}

const salesSource = new DatabaseConfig({
    name: 'sales',
    type: Dialect.PostgreSQL,
    description: 'Synthetic fixture',
    host: 'localhost',
    port: 5432,
    database: 'sales',
    username: 'reader',
    password: 'supersecret',
});

function makeRegistry(sources: DatabaseConfig[]) {
    const get = vi.fn(async (name: string) => {
        const found = sources.find((database) => database.name === name);
        if (!found) throw new SafeError(ErrorCode.NotFound);
        return found;
    });
    const list = vi.fn(async () => [...sources]);
    return { registry: { get, list } satisfies SourceRegistry, get, list };
}

function setup(rows: unknown[][] = [[1]]) {
    const adapter = makeAdapter(rows);
    const { registry, get } = makeRegistry([salesSource]);
    const service = new QueryService(
        registry,
        undefined,
        () => adapter,
        new Logger(() => undefined),
    );
    return { service, adapter, get };
}

describe('query service', () => {
    it('closes each lazy adapter once and rejects further queries', async () => {
        const { service, adapter } = setup();
        await service.query({ database: 'sales', sql: 'SELECT 1' });
        await Promise.all([service.close(), service.close()]);
        expect(adapter.close).toHaveBeenCalledTimes(1);
        await expect(service.query({ database: 'sales', sql: 'SELECT 1' })).rejects.toThrow(
            'CLOSED',
        );
    });

    it('never exposes connection details in database lists', async () => {
        const { service } = setup();
        expect(await service.listDatabases()).toEqual([
            { name: 'sales', type: 'postgres', description: 'Synthetic fixture' },
        ]);
        expect(JSON.stringify(await service.listDatabases())).not.toContain('supersecret');
    });

    it('fetches each source once and caches the adapter across queries', async () => {
        const { service, adapter, get } = setup();
        await service.query({ database: 'sales', sql: 'SELECT 1' });
        await service.query({ database: 'sales', sql: 'SELECT 1' });
        expect(get).toHaveBeenCalledTimes(1);
        expect(adapter.query).toHaveBeenCalledTimes(2);
    });

    it('passes the stored password only to the adapter factory', async () => {
        const adapter = makeAdapter();
        const { registry } = makeRegistry([salesSource]);
        const factory = vi.fn(() => adapter);
        const service = new QueryService(registry, undefined, factory, new Logger(() => undefined));
        await service.query({ database: 'sales', sql: 'SELECT 1' });
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ password: 'supersecret' }));
        expect(JSON.stringify(await service.listDatabases())).not.toContain('supersecret');
    });

    it('propagates registry failures and allows retry', async () => {
        const adapter = makeAdapter();
        const { registry, get } = makeRegistry([salesSource]);
        get.mockRejectedValueOnce(new SafeError(ErrorCode.NotFound));
        const service = new QueryService(
            registry,
            undefined,
            () => adapter,
            new Logger(() => undefined),
        );
        await expect(service.query({ database: 'sales', sql: 'SELECT 1' })).rejects.toThrow();
        expect(adapter.query).not.toHaveBeenCalled();
        await service.query({ database: 'sales', sql: 'SELECT 1' });
        expect(adapter.query).toHaveBeenCalledTimes(1);
    });

    it('rejects unknown sources without calling the driver', async () => {
        const { service, adapter } = setup();
        await expect(service.query({ database: 'missing', sql: 'SELECT 1' })).rejects.toThrow(
            'NOT_FOUND',
        );
        expect(adapter.query).not.toHaveBeenCalled();
    });

    it('passes table-like filters through to describe', async () => {
        const { service, adapter } = setup();
        await service.describe({ database: 'sales', tableLike: 'spu%' });
        expect(adapter.describe).toHaveBeenCalledWith(
            undefined,
            undefined,
            'spu%',
            expect.anything(),
        );
        await expect(
            service.describe({ database: 'sales', table: 'users', tableLike: 'spu%' }),
        ).rejects.toThrow('INVALID_REQUEST');
    });

    it('rejects a truncated whole-database describe instead of returning partial structure', async () => {
        const adapter = makeAdapter();
        const manyTables = Array.from({ length: 1001 }, (_, index) => [`t${index}`, `c${index}`]);
        adapter.describe.mockResolvedValue({
            columns: ['table_name', 'column_name'],
            rows: manyTables,
        });
        const { registry } = makeRegistry([salesSource]);
        const service = new QueryService(
            registry,
            undefined,
            () => adapter,
            new Logger(() => undefined),
        );
        await expect(service.describe({ database: 'sales' })).rejects.toThrow('RESULT_TOO_LARGE');
        const withTable = await service.describe({ database: 'sales', table: 'users' });
        expect(withTable.truncated).toBe(true);
    });

    it('shows full connection details except the password', async () => {
        const { service } = setup();
        const shown = await service.showSource('sales');
        expect(shown).toEqual({
            name: 'sales',
            type: 'postgres',
            description: 'Synthetic fixture',
            host: 'localhost',
            port: 5432,
            database: 'sales',
            username: 'reader',
        });
        expect(JSON.stringify(shown)).not.toContain('supersecret');
    });

    it('rejects writes before calling the driver', async () => {
        const { service, adapter } = setup();
        await expect(
            service.query({ database: 'sales', sql: 'DELETE FROM users' }),
        ).rejects.toThrow();
        expect(adapter.query).not.toHaveBeenCalled();
    });

    it('binds parameters and marks truncation', async () => {
        const adapter = makeAdapter([[1], [2], [3]]);
        const { registry } = makeRegistry([salesSource]);
        const service = new QueryService(
            registry,
            { ...SourceSchema.defaultLimits, maxRows: 2 },
            () => adapter,
            new Logger(() => undefined),
        );
        const result = await service.query({
            database: 'sales',
            sql: 'SELECT $1',
            parameters: [1],
        });
        expect(result.rows).toEqual([[1], [2]]);
        expect(result.truncated).toBe(true);
        expect(adapter.query.mock.calls[0]?.[1]).toEqual([1]);
    });

    it.each([
        { database: 'sales', sql: 'SELECT 1', maxRows: 3 },
        { database: 'sales', sql: 'SELECT 1', parameters: [Infinity] },
        { database: 'sales', sql: 'SELECT 1', maxRows: 0 },
    ])('rejects invalid requests', async (request) => {
        const adapter = makeAdapter();
        const { registry } = makeRegistry([salesSource]);
        const service = new QueryService(
            registry,
            { ...SourceSchema.defaultLimits, maxRows: 2 },
            () => adapter,
            new Logger(() => undefined),
        );
        await expect(service.query(request)).rejects.toThrow();
        expect(adapter.query).not.toHaveBeenCalled();
    });

    it('normalizes big integers and duplicate columns', async () => {
        const { service, adapter } = setup();
        adapter.query.mockResolvedValue({ columns: ['id', 'id'], rows: [[1n, 9007199254740993n]] });
        const result = await service.query({ database: 'sales', sql: 'SELECT 1' });
        expect(result.rows).toEqual([['1', '9007199254740993']]);
        expect(result.columns).toEqual(['id', 'id']);
    });

    it('redacts all unknown driver errors', async () => {
        const { service, adapter } = setup();
        adapter.query.mockRejectedValue(new Error('connection failed: supersecret'));
        await expect(service.query({ database: 'sales', sql: 'SELECT 1' })).rejects.toThrow(
            'DATABASE_ERROR',
        );
        await expect(service.query({ database: 'sales', sql: 'SELECT 1' })).rejects.not.toThrow(
            'supersecret',
        );
    });

    it('rejects oversized fields and bounds concurrency', async () => {
        const { service, adapter } = setup([['a'.repeat(1048577)]]);
        await expect(service.query({ database: 'sales', sql: 'SELECT 1' })).rejects.toThrow(
            'RESULT_TOO_LARGE',
        );
        adapter.query.mockImplementation(() => new Promise(() => {}));
        const pending = Array.from({ length: 4 }, () =>
            service.query({ database: 'sales', sql: 'SELECT 1' }),
        );
        await expect(service.query({ database: 'sales', sql: 'SELECT 1' })).rejects.toThrow('BUSY');
        void pending;
    });
});
