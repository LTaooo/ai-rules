import { describe, expect, it, vi } from 'vitest';
import { fixtureConfig as loadConfig } from '../../helpers/FixtureConfig.js';
import { QueryService } from '../../../src/application/QueryService.js';

function setup(rows: unknown[][] = [[1]]) {
    const adapter = {
        query: vi.fn().mockResolvedValue({ columns: ['id'], rows }),
        describe: vi.fn().mockResolvedValue({ columns: ['table_name'], rows: [['users']] }),
        close: vi.fn().mockResolvedValue(undefined),
    };
    const config = loadConfig({
        DB_SALES_URL: 'postgresql://reader:supersecret@localhost:5432/sales',
        MCP_DB_MAX_ROWS: '2',
    });
    return { service: new QueryService(config, () => adapter), adapter };
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
    it('never exposes connection details in database lists', () => {
        const { service } = setup();
        expect(service.listDatabases()).toEqual([
            { name: 'sales', type: 'postgres', description: 'Synthetic fixture' },
        ]);
        expect(JSON.stringify(service.listDatabases())).not.toContain('supersecret');
    });

    it('rejects writes before calling the driver', async () => {
        const { service, adapter } = setup();
        await expect(
            service.query({ database: 'sales', sql: 'DELETE FROM users' }),
        ).rejects.toThrow();
        expect(adapter.query).not.toHaveBeenCalled();
    });

    it('binds parameters and marks truncation', async () => {
        const { service, adapter } = setup([[1], [2], [3]]);
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
        { database: 'missing', sql: 'SELECT 1' },
        { database: 'sales', sql: 'SELECT 1', maxRows: 3 },
        { database: 'sales', sql: 'SELECT 1', parameters: [Infinity] },
        { database: 'sales', sql: 'SELECT 1', maxRows: 0 },
    ])('rejects invalid requests', async (request) => {
        const { service, adapter } = setup();
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
