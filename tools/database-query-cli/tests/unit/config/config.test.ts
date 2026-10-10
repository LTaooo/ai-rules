import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigLoader } from '../../../src/infrastructure/config/ConfigLoader.js';
import { ErrorCode } from '../../../src/domain/enums/ErrorCode.js';

mkdirSync('.test-artifacts', { recursive: true });
const folders: string[] = [];
const remote = {
    name: 'sales_1',
    type: 'postgres',
    description: 'Public sales',
    host: 'example.test',
    database: 'sales',
    username: 'fictional-reader',
    password: 'fictional-password',
    sslMode: 'verify-full',
};
function fixture(raw: unknown) {
    const folder = mkdtempSync(resolve('.test-artifacts/config-'));
    folders.push(folder);
    mkdirSync(resolve(folder, 'config'));
    writeFileSync(resolve(folder, 'config/databases.json'), JSON.stringify(raw));
    return { folder, loader: new ConfigLoader(undefined, folder) };
}
afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
describe('JSON config', () => {
    it('supports three types, descriptions and JSON credentials without loading synthetic .env', () => {
        const { folder, loader } = fixture({ databases: [remote] });
        const filename = resolve(folder, 'existing.sqlite');
        writeFileSync(filename, '');
        writeFileSync(resolve(folder, '.env'), 'DB_BAD_URL=never-load-this\nMCP_DB_MAX_ROWS=1');
        writeFileSync(
            resolve(folder, 'config/databases.json'),
            JSON.stringify({
                databases: [
                    remote,
                    { ...remote, name: 'analytics', type: 'mysql', sslMode: undefined, tls: true },
                    { name: 'local', type: 'sqlite', description: 'Local fixture', filename },
                ],
            }),
        );
        const config = loader.load();
        expect(config.databases.map((database) => database.publicInfo)).toEqual([
            { name: 'sales_1', type: 'postgres', description: 'Public sales' },
            { name: 'analytics', type: 'mysql', description: 'Public sales' },
            { name: 'local', type: 'sqlite', description: 'Local fixture' },
        ]);
        expect(config.databases[0]).toMatchObject({
            username: 'fictional-reader',
            password: 'fictional-password',
            port: 5432,
        });
        expect(config.databases[1]?.port).toBe(3306);
        expect(config.limits).toEqual({
            maxRows: 1000,
            timeoutMs: 10000,
            maxResponseBytes: 1048576,
            maxConcurrency: 4,
        });
        expect(
            JSON.stringify(config.databases.map((database) => database.publicInfo)),
        ).not.toContain('fictional');
    });
    it('resolves CLI relative and absolute paths and rejects malformed arguments', () => {
        const { folder } = fixture({ databases: [remote] });
        expect(
            ConfigLoader.fromArguments(['--config', 'config/databases.json'], folder).load()
                .databases,
        ).toHaveLength(1);
        expect(
            ConfigLoader.fromArguments(
                ['--config', resolve(folder, 'config/databases.json')],
                folder,
            ).load().databases,
        ).toHaveLength(1);
        for (const args of [
            ['--config'],
            ['--unknown', 'file'],
            ['--config', 'a', '--config', 'b'],
            ['--config', ''],
        ])
            expect(() => ConfigLoader.fromArguments(args, folder)).toThrow(ErrorCode.ConfigError);
    });
    it('does not share mutable default limits', () => {
        const { loader } = fixture({ databases: [remote] });
        const first = loader.load();
        first.limits.maxRows = 1;
        expect(loader.load().limits.maxRows).toBe(1000);
    });
    it.each([
        null,
        [],
        {},
        { databases: [] },
        {
            databases: Array.from({ length: 65 }, (_, index) => ({
                ...remote,
                name: `db_${index}`,
            })),
        },
        { databases: [remote, remote] },
        ...[
            { type: 'unknown' },
            { name: '' },
            { description: undefined },
            { host: undefined },
            { username: undefined },
            { password: undefined },
            { port: 0 },
            { port: 65536 },
            { port: '5432' },
            { sslMode: 'unsafe' },
            { usernameEnv: 'SECRET' },
            { type: 'mysql', sslMode: undefined, tls: 'true' },
            { type: 'sqlite', filename: ':memory:' },
            { type: 'sqlite', filename: 'relative.sqlite' },
        ].map((overrides) => ({ databases: [{ ...remote, ...overrides }] })),
        ...[0, -1, 1.5, 10001, '5', null].map((maxRows) => ({
            databases: [remote],
            limits: { maxRows },
        })),
        { databases: [remote], limits: { timeoutMs: 60001 } },
        { databases: [remote], limits: { maxConcurrency: 17 } },
        { databases: [remote], limits: { maxResponseBytes: 10485761 } },
    ])('rejects invalid fields without leaking credentials', (raw) => {
        const { loader } = fixture(raw);
        expect(() => loader.load()).toThrow(ErrorCode.ConfigError);
        try {
            loader.load();
        } catch (error) {
            expect(String(error)).not.toContain('fictional-password');
            expect(String(error)).not.toContain('example.test');
        }
    });
    it('redacts missing files and malformed JSON', () => {
        const { folder, loader } = fixture({ databases: [remote] });
        writeFileSync(resolve(folder, 'config/databases.json'), '{fictional-password');
        expect(() => loader.load()).toThrow(ErrorCode.ConfigError);
        expect(() => new ConfigLoader('missing.json', folder).load()).toThrow(
            ErrorCode.ConfigError,
        );
    });
});
