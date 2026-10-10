import { LogEvent } from '../../../src/domain/enums/LogEvent.js';
import { describe, expect, it } from 'vitest';
import { Logger } from '../../../src/infrastructure/logging/Logger.js';

describe('stderr logger', () => {
    it('emits structured events without exposing sensitive fields', () => {
        const lines: string[] = [];
        const logger = new Logger((line) => lines.push(line));

        logger.info(LogEvent.QueryCompleted, {
            requestId: 'request-1',
            database: 'sales',
            durationMs: 12,
            returnedRows: 3,
            sql: 'SELECT password FROM users',
            parameters: 'top-secret',
            connectionUrl: 'postgresql://reader:password@example.test/sales',
            resultData: 'sensitive-value',
        });

        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/\n$/);
        const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(entry).toMatchObject({
            level: 'info',
            event: LogEvent.QueryCompleted,
            requestId: 'request-1',
            database: 'sales',
            durationMs: 12,
            returnedRows: 3,
            sql: '[REDACTED]',
            parameters: '[REDACTED]',
            connectionUrl: '[REDACTED]',
            resultData: '[REDACTED]',
        });
        expect(lines[0]).not.toContain('top-secret');
        expect(lines[0]).not.toContain('password@example.test');
        expect(lines[0]).not.toContain('sensitive-value');
    });

    it('supports warning and error levels', () => {
        const lines: string[] = [];
        const logger = new Logger((line) => lines.push(line));

        logger.warn(LogEvent.QueryFailed, { code: 'SQL_REJECTED' });
        logger.error(LogEvent.ServerStartFailed, { code: 'CONFIG_ERROR' });

        expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
            'warn',
            'error',
        ]);
    });
});
