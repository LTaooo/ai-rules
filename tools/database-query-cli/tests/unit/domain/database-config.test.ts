import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Dialect } from '../../../src/domain/enums/Dialect.js';
import { SslMode } from '../../../src/domain/enums/SslMode.js';
import { DatabaseConfig } from '../../../src/domain/models/DatabaseConfig.js';
import { SourceSchema } from '../../../src/infrastructure/config/SourceSchema.js';

describe('DatabaseConfig', () => {
    it('replaces name and description while preserving every other field', () => {
        const source = new DatabaseConfig({
            name: 'sales',
            type: Dialect.PostgreSQL,
            description: 'Synthetic',
            host: 'example.test',
            port: 5432,
            database: 'sales',
            username: 'reader',
            password: 'secret-value',
            sslMode: SslMode.VerifyFull,
        });
        const updated = source.withNameAndDescription('finance', 'Finance read-only');
        expect(updated).not.toBe(source);
        expect(updated.name).toBe('finance');
        expect(updated.description).toBe('Finance read-only');
        expect(updated.password).toBe('secret-value');
        expect(updated.host).toBe('example.test');
        expect(updated.port).toBe(5432);
        expect(updated.database).toBe('sales');
        expect(updated.username).toBe('reader');
        expect(updated.sslMode).toBe(SslMode.VerifyFull);
        expect(source.name).toBe('sales');
        expect(source.description).toBe('Synthetic');
    });

    it('drops undefined fields when serialized so the payload still validates', () => {
        const sqlite = new DatabaseConfig({
            name: 'local',
            type: Dialect.SQLite,
            description: 'Local fixture',
            filename: resolve('.test-artifacts/fixture-local.sqlite'),
        });
        const payload = JSON.stringify(sqlite.withNameAndDescription('local2', 'Moved fixture'));
        expect(payload).not.toContain('password');
        expect(payload).not.toContain('host');
        const parsed = SourceSchema.validateDatabase(JSON.parse(payload) as unknown);
        expect(parsed.name).toBe('local2');
        expect(parsed.description).toBe('Moved fixture');
        expect(parsed.filename).toBe(resolve('.test-artifacts/fixture-local.sqlite'));
    });
});
