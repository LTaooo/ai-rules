import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { ErrorCode } from '../../../src/domain/enums/ErrorCode.js';
import { SourceSchema } from '../../../src/infrastructure/config/SourceSchema.js';

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

describe('source schema', () => {
    it('validates three types and projects only public info', () => {
        const config = SourceSchema.validateDatabase(remote);
        expect(config.publicInfo).toEqual({
            name: 'sales_1',
            type: 'postgres',
            description: 'Public sales',
        });
        expect(config.password).toBe('fictional-password');
        expect(config.port).toBe(5432);
        expect(config.sslMode).toBe('verify-full');
        const mysql = SourceSchema.validateDatabase({
            name: 'analytics',
            type: 'mysql',
            description: 'Public sales',
            host: 'example.test',
            database: 'sales',
            username: 'fictional-reader',
            password: 'fictional-password',
            tls: true,
        });
        expect(mysql.port).toBe(3306);
        expect(mysql.tls).toBe(true);
        const local = SourceSchema.validateDatabase({
            name: 'local',
            type: 'sqlite',
            description: 'Local fixture',
            filename: resolve('/srv/data/local.sqlite'),
        });
        expect(local.filename).toBe(resolve('/srv/data/local.sqlite'));
        expect(local.password).toBeUndefined();
        expect(local.host).toBeUndefined();
    });

    it('exposes built-in default limits', () => {
        expect(SourceSchema.defaultLimits).toEqual({
            maxRows: 1000,
            timeoutMs: 10000,
            maxResponseBytes: 1048576,
            maxConcurrency: 4,
        });
    });

    it.each([
        null,
        [],
        {},
        { ...remote, name: '' },
        { ...remote, name: 'has space' },
        { ...remote, description: undefined },
        { ...remote, host: undefined },
        { ...remote, username: undefined },
        { ...remote, password: undefined },
        { ...remote, password: 'x'.repeat(1025) },
        { ...remote, credential: 'legacy-indirection' },
        { ...remote, port: 0 },
        { ...remote, port: 65536 },
        { ...remote, port: '5432' },
        { ...remote, sslMode: 'unsafe' },
        { ...remote, usernameEnv: 'SECRET' },
        { ...remote, type: 'unknown' },
        { ...remote, type: 'mysql', sslMode: undefined, tls: 'true' },
        { ...remote, database: 'a/b' },
        { name: 'local', type: 'sqlite', description: 'Local', filename: ':memory:' },
        { name: 'local', type: 'sqlite', description: 'Local', filename: 'relative.sqlite' },
        {
            name: 'local',
            type: 'sqlite',
            description: 'Local',
            filename: resolve('/srv/data/local.sqlite'),
            password: 'x',
        },
        {
            databases: [remote],
        },
    ])('rejects invalid entries without echoing values', (raw) => {
        expect(() => SourceSchema.validateDatabase(raw)).toThrow(ErrorCode.ConfigError);
        try {
            SourceSchema.validateDatabase(raw);
        } catch (error) {
            expect(String(error)).not.toContain('fictional-password');
            expect(String(error)).not.toContain('example.test');
        }
    });
});
