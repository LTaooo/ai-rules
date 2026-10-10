import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter as EventEmitterType } from 'node:events';
import type { Readable as ReadableType } from 'node:stream';
import type { AppConfig as Config } from '../../../src/domain/models/AppConfig.js';

const mocks = vi.hoisted(() => ({
    clients: [] as unknown[],
    mysqlConnections: [] as unknown[],
    mode: '',
    mysqlVersion: '8.0.36',
    postgresOptions: [] as unknown[],
    mysqlOptions: [] as unknown[],
}));
vi.mock('pg', async () => {
    const { EventEmitter } = await import('node:events');
    class Client extends EventEmitter {
        connect = vi.fn().mockResolvedValue(undefined);
        end = vi.fn().mockResolvedValue(undefined);
        query = vi.fn((query: unknown) => {
            if (typeof query === 'string') {
                if (query === 'SHOW transaction_read_only')
                    return Promise.resolve({
                        rows: [{ transaction_read_only: mocks.mode === 'unsafe' ? 'off' : 'on' }],
                    });
                if (query.includes('rolsuper'))
                    return Promise.resolve({
                        rows: [
                            {
                                rolsuper: false,
                                rolcreatedb: false,
                                rolcreaterole: false,
                                rolreplication: false,
                            },
                        ],
                    });
                return Promise.resolve({ rows: [] });
            }
            return query;
        });
        constructor(options: unknown) {
            super();
            mocks.postgresOptions.push(options);
            mocks.clients.push(this);
        }
    }
    return { default: { Client }, Client };
});
vi.mock('pg-cursor', () => ({
    default: class Cursor {
        reads = 0;
        read = vi.fn(
            (
                _count: number,
                callback: (error: null, rows: unknown[][], result: unknown) => void,
            ) => {
                if (mocks.mode === 'hang') return;
                callback(null, this.reads++ === 0 ? [[1], [2], [3]] : [], {
                    fields: [{ name: 'id' }],
                });
            },
        );
        close = vi.fn().mockResolvedValue(undefined);
    },
}));
vi.mock('mysql2', async () => {
    const { EventEmitter } = await import('node:events');
    const { Readable } = await import('node:stream');
    return {
        default: {
            createConnection: vi.fn((options: unknown) => {
                mocks.mysqlOptions.push(options);
                const connection = new EventEmitter() as EventEmitterType & {
                    promise: ReturnType<typeof vi.fn>;
                    execute: ReturnType<typeof vi.fn>;
                    destroy: ReturnType<typeof vi.fn>;
                };
                connection.promise = vi.fn(() => ({
                    connect: vi.fn().mockResolvedValue(undefined),
                    query: vi.fn((sql: string) => {
                        if (
                            mocks.mode === 'timeout-setup-fail' &&
                            sql.includes('MAX_EXECUTION_TIME')
                        )
                            return Promise.reject({ code: 'ER_UNKNOWN_SYSTEM_VARIABLE' });
                        if (
                            mocks.mode === 'readonly-fail' &&
                            sql === 'SET SESSION TRANSACTION READ ONLY'
                        )
                            return Promise.reject({ code: 'ER_NOT_SUPPORTED_YET' });
                        if (sql === 'SELECT VERSION()' && mocks.mode === 'version-hang')
                            return new Promise(() => {});
                        return sql === 'SELECT VERSION()'
                            ? Promise.resolve([[[mocks.mysqlVersion]], []])
                            : Promise.resolve([[], []]);
                    }),
                }));
                connection.destroy = vi.fn();
                connection.execute = vi.fn(() => {
                    const query = new EventEmitter() as EventEmitterType & {
                        stream: () => ReadableType;
                    };
                    query.stream = () => {
                        const stream =
                            mocks.mode === 'hang'
                                ? new Readable({ objectMode: true, read() {} })
                                : Readable.from([[1], [2], [3]], { objectMode: true });
                        queueMicrotask(() => query.emit('fields', [{ name: 'id' }]));
                        return stream;
                    };
                    return query;
                });
                mocks.mysqlConnections.push(connection);
                return connection;
            }),
        },
    };
});

import { PostgresAdapter } from '../../../src/infrastructure/database/postgres/PostgresAdapter.js';
import { MysqlAdapter } from '../../../src/infrastructure/database/mysql/MysqlAdapter.js';
import { fixtureConfig as loadConfig } from '../../helpers/FixtureConfig.js';

afterEach(() => {
    mocks.clients.length = 0;
    mocks.mysqlConnections.length = 0;
    mocks.mode = '';
    mocks.mysqlVersion = '8.0.36';
    mocks.postgresOptions.length = 0;
    mocks.mysqlOptions.length = 0;
});

describe('remote adapters with fake drivers', () => {
    it('passes structured JSON credentials directly to drivers without connection URLs', async () => {
        for (const type of ['postgres', 'mysql'] as const) {
            const config = loadConfig({
                DB_TEST_URL: `${type}://fake-reader:fake%40password@localhost:1234/fake`,
            });
            const adapter =
                type === 'postgres'
                    ? new PostgresAdapter(config.databases[0]!)
                    : new MysqlAdapter(config.databases[0]!);
            await adapter.query('SELECT 1', [], config.limits);
            const options = type === 'postgres' ? mocks.postgresOptions[0] : mocks.mysqlOptions[0];
            expect(options).toMatchObject({
                host: 'localhost',
                port: 1234,
                database: 'fake',
                user: 'fake-reader',
                password: 'fake@password',
            });
            expect(options).not.toHaveProperty('connectionString');
            await adapter.close();
        }
    });
    it('refuses PostgreSQL when read-only protection was not established', async () => {
        mocks.mode = 'unsafe';
        const config = loadConfig({ DB_TEST_URL: 'postgresql://reader:fake@localhost/db' });
        const adapter = new PostgresAdapter(config.databases[0]!);
        await expect(adapter.query('SELECT 1', [], config.limits)).rejects.toThrow(
            'READ_ONLY_REQUIRED',
        );
        const client = mocks.clients[0] as { end: ReturnType<typeof vi.fn> };
        expect(client.end).toHaveBeenCalled();
        await adapter.close();
    });

    it('terminates timed-out PostgreSQL connections', async () => {
        mocks.mode = 'hang';
        const config = loadConfig({
            DB_TEST_URL: 'postgresql://reader:fake@localhost/db',
            MCP_DB_QUERY_TIMEOUT_MS: '50',
        });
        const adapter = new PostgresAdapter(config.databases[0]!);
        await expect(adapter.query('SELECT 1', [], config.limits)).rejects.toThrow('TIMEOUT');
        const client = mocks.clients[0] as { end: ReturnType<typeof vi.fn> };
        expect(client.end).toHaveBeenCalled();
        await adapter.close();
    });

    it('terminates timed-out MySQL streams and connections', async () => {
        mocks.mode = 'hang';
        const config = loadConfig({
            DB_TEST_URL: 'mysql://reader:fake@localhost/db',
            MCP_DB_QUERY_TIMEOUT_MS: '50',
        });
        const adapter = new MysqlAdapter(config.databases[0]!);
        await expect(adapter.query('SELECT 1', [], config.limits)).rejects.toThrow('TIMEOUT');
        const connection = mocks.mysqlConnections[0] as { destroy: ReturnType<typeof vi.fn> };
        expect(connection.destroy).toHaveBeenCalled();
        await adapter.close();
    });

    it('runs PostgreSQL in a read-only transaction and always rolls back', async () => {
        const config: Config = loadConfig({
            DB_TEST_URL: 'postgresql://reader:fake@localhost/db',
            MCP_DB_MAX_ROWS: '2',
        });
        const adapter = new PostgresAdapter(config.databases[0]!);
        const result = await adapter.query('SELECT id FROM users', [], config.limits);
        expect(result.rows).toHaveLength(3);
        const client = mocks.clients[0] as {
            query: ReturnType<typeof vi.fn>;
            end: ReturnType<typeof vi.fn>;
        };
        expect(client.query).toHaveBeenCalledWith('BEGIN READ ONLY');
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.end).toHaveBeenCalled();
        await adapter.close();
    });

    it.each(['5.6.5', '5.6.99', '5.7.7'])(
        'accepts legacy MySQL %s without MAX_EXECUTION_TIME',
        async (version) => {
            mocks.mysqlVersion = version;
            const config = loadConfig({ DB_TEST_URL: 'mysql://reader:fake@localhost/db' });
            const adapter = new MysqlAdapter(config.databases[0]!);
            await adapter.query('SELECT 1', [], config.limits);
            const connection = mocks.mysqlConnections[0] as { promise: ReturnType<typeof vi.fn> };
            const promise = connection.promise.mock.results[0]?.value as {
                query: ReturnType<typeof vi.fn>;
            };
            expect(promise.query).toHaveBeenCalledWith('SELECT VERSION()');
            expect(promise.query).toHaveBeenCalledWith('SET SESSION TRANSACTION READ ONLY');
            expect(promise.query).toHaveBeenCalledWith('START TRANSACTION READ ONLY');
            expect(promise.query).toHaveBeenCalledWith('ROLLBACK');
            expect(promise.query).not.toHaveBeenCalledWith(
                expect.stringContaining('MAX_EXECUTION_TIME'),
            );
            await adapter.close();
        },
    );

    it.each(['5.6.4', '5.8.1', '8.0.36-MariaDB', '9.0.1', '8.0.36-custom'])(
        'rejects unsupported MySQL version %s',
        async (version) => {
            mocks.mysqlVersion = version;
            const config = loadConfig({ DB_TEST_URL: 'mysql://reader:fake@localhost/db' });
            const adapter = new MysqlAdapter(config.databases[0]!);
            await expect(adapter.query('SELECT 1', [], config.limits)).rejects.toThrow(
                'DATABASE_ERROR',
            );
            await adapter.close();
        },
    );

    it('times out while checking the MySQL version and cleans up', async () => {
        mocks.mode = 'version-hang';
        const config = loadConfig({
            DB_TEST_URL: 'mysql://reader:fake@localhost/db',
            MCP_DB_QUERY_TIMEOUT_MS: '50',
        });
        const adapter = new MysqlAdapter(config.databases[0]!);
        await expect(adapter.query('SELECT 1', [], config.limits)).rejects.toThrow('TIMEOUT');
        expect(
            (mocks.mysqlConnections[0] as { destroy: ReturnType<typeof vi.fn> }).destroy,
        ).toHaveBeenCalled();
        await adapter.close();
    });

    it.each(['5.7.8', '8.0.40', '8.0.40-community-log'])(
        'requires server timeout on %s and never falls back after setup failure',
        async (version) => {
            mocks.mysqlVersion = version;
            mocks.mode = 'timeout-setup-fail';
            const config = loadConfig({ DB_TEST_URL: 'mysql://reader:fake@localhost/db' });
            const adapter = new MysqlAdapter(config.databases[0]!);
            await expect(adapter.query('SELECT 1', [], config.limits)).rejects.toMatchObject({
                code: 'DATABASE_ERROR',
                diagnostic: { stage: 'TIMEOUT_SETUP', reason: 'ER_UNKNOWN_SYSTEM_VARIABLE' },
            });
            const connection = mocks.mysqlConnections[0] as {
                execute: ReturnType<typeof vi.fn>;
                destroy: ReturnType<typeof vi.fn>;
            };
            expect(connection.execute).not.toHaveBeenCalled();
            expect(connection.destroy).toHaveBeenCalled();
            await adapter.close();
        },
    );

    it('requires read-only setup even on MySQL 5.6', async () => {
        mocks.mysqlVersion = '5.6.51';
        mocks.mode = 'readonly-fail';
        const config = loadConfig({ DB_TEST_URL: 'mysql://reader:fake@localhost/db' });
        const adapter = new MysqlAdapter(config.databases[0]!);
        await expect(adapter.query('SELECT 1', [], config.limits)).rejects.toMatchObject({
            code: 'DATABASE_ERROR',
            diagnostic: { stage: 'READ_ONLY' },
        });
        expect(
            (mocks.mysqlConnections[0] as { execute: ReturnType<typeof vi.fn> }).execute,
        ).not.toHaveBeenCalled();
        await adapter.close();
    });

    it('streams MySQL prepared results with a read-only transaction and server timeout', async () => {
        const config = loadConfig({
            DB_TEST_URL: 'mysql://reader:fake@localhost/db',
            MCP_DB_MAX_ROWS: '2',
        });
        const adapter = new MysqlAdapter(config.databases[0]!);
        const result = await adapter.query('SELECT ? AS id', [1], config.limits);
        expect(result.rows).toHaveLength(3);
        const connection = mocks.mysqlConnections[0] as {
            execute: ReturnType<typeof vi.fn>;
            promise: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        };
        const promise = connection.promise.mock.results[0]?.value as {
            query: ReturnType<typeof vi.fn>;
        };
        expect(promise.query).toHaveBeenCalledWith('START TRANSACTION READ ONLY');
        expect(promise.query).toHaveBeenCalledWith('SET SESSION MAX_EXECUTION_TIME = 10000');
        expect(connection.execute).toHaveBeenCalledWith('SELECT ? AS id', [1]);
        expect(connection.destroy).toHaveBeenCalled();
        await adapter.close();
    });
});
