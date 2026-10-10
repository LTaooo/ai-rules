import { DatabaseConfig } from '../../../src/domain/models/DatabaseConfig.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureConfig as loadConfig } from '../../helpers/FixtureConfig.js';
import { QueryService } from '../../../src/application/QueryService.js';
import { SqliteAdapter } from '../../../src/infrastructure/database/sqlite/SqliteAdapter.js';

mkdirSync('.test-artifacts', { recursive: true });
const folders: string[] = [];
const services: QueryService[] = [];
afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fixture() {
    const folder = mkdtempSync(resolve('.test-artifacts/sqlite-'));
    folders.push(folder);
    const filename = resolve(folder, 'test.sqlite');
    const database = new DatabaseSync(filename);
    database.exec(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users VALUES (1, 'Ada'), (2, 'Lin'), (3, 'Pat');",
    );
    database.close();
    const url = pathToFileURL(filename).href.replace('file:', 'sqlite:');
    const config = loadConfig({ DB_LOCAL_URL: url, MCP_DB_MAX_ROWS: '2' });
    const service = new QueryService(config);
    services.push(service);
    return { filename, config, service };
}

describe('real SQLite read-only adapter', () => {
    it('queries existing files and enforces row limits and parameters', async () => {
        const { service } = fixture();
        const result = await service.query({
            database: 'local',
            sql: 'SELECT id, name FROM users WHERE id > ? ORDER BY id',
            parameters: [0],
        });
        expect(result.columns).toEqual(['id', 'name']);
        expect(result.rows).toEqual([
            ['1', 'Ada'],
            ['2', 'Lin'],
        ]);
        expect(result.truncated).toBe(true);
    });

    it('preserves duplicate names and an existing LIMIT', async () => {
        const { service } = fixture();
        const result = await service.query({
            database: 'local',
            sql: 'SELECT id, id FROM users ORDER BY id DESC LIMIT 1',
        });
        expect(result.columns).toEqual(['id', 'id']);
        expect(result.rows).toEqual([['3', '3']]);
        expect(result.truncated).toBe(false);
    });

    it('describes columns and primary keys, safely handling table input', async () => {
        const { service } = fixture();
        const result = await service.describe({ database: 'local', table: 'users' });
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]?.[1]).toBe('users');
        await expect(
            service.describe({ database: 'local', table: "users'; DROP TABLE users; --" }),
        ).rejects.toThrow('NOT_FOUND');
        await expect(service.describe({ database: 'local', schema: 'other' })).rejects.toThrow();
    });

    it('blocks writes at the database layer even without the SQL guard', async () => {
        const { config, filename } = fixture();
        const rawConnection = new DatabaseSync(filename, { readOnly: true });
        try {
            expect(() => rawConnection.exec('DELETE FROM users')).toThrow();
            expect(() => rawConnection.exec('CREATE TABLE forbidden (id INT)')).toThrow();
        } finally {
            rawConnection.close();
        }
        const adapter = new SqliteAdapter(config.databases[0]!);
        await expect(adapter.query('DELETE FROM users', [], config.limits)).rejects.toThrow();
        await expect(
            adapter.query('CREATE TABLE evil (id INT)', [], config.limits),
        ).rejects.toThrow();
        await adapter.close();
    });

    it('never creates absent database files', async () => {
        const { config, filename } = fixture();
        const missing = `${filename}.missing`;
        const adapter = new SqliteAdapter(
            new DatabaseConfig({ ...config.databases[0]!, filename: missing }),
        );
        await expect(adapter.query('SELECT 1', [], config.limits)).rejects.toThrow();
        expect(existsSync(missing)).toBe(false);
        await adapter.close();
    });

    it('terminates expensive work and remains usable', async () => {
        const { config } = fixture();
        const adapter = new SqliteAdapter(config.databases[0]!);
        const expensive =
            'WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 100000000) SELECT SUM(value) FROM sequence';
        await expect(
            adapter.query(expensive, [], { ...config.limits, timeoutMs: 200 }),
        ).rejects.toThrow('TIMEOUT');
        const result = await adapter.query('SELECT 1', [], config.limits);
        expect(result.rows).toEqual([[1n]]);
        await adapter.close();
    });
});
