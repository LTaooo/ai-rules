import { expect, it } from 'vitest';
import { DatabaseStage } from '../../../src/domain/enums/DatabaseStage.js';
import { SafeError } from '../../../src/shared/errors/SafeError.js';

it('retains only a fixed diagnostic stage and allowlisted driver code', () => {
    const error = SafeError.database(
        { code: 'HANDSHAKE_SSL_ERROR', message: 'private detail', password: 'fictional-secret' },
        DatabaseStage.Connect,
    );
    expect(error.message).toBe('DATABASE_ERROR');
    expect(error.diagnostic).toEqual({ stage: 'CONNECT', reason: 'HANDSHAKE_SSL_ERROR' });
    expect(JSON.stringify(error)).not.toContain('private detail');
    expect(JSON.stringify(error)).not.toContain('fictional-secret');
});

it.each(['HANDSHAKE_NO_SSL_SUPPORT', 'AUTH_SWITCH_PLUGIN_ERROR', 'PROTOCOL_CONNECTION_LOST'])(
    'preserves the fixed connection diagnostic %s without private details',
    (code) => {
        const error = SafeError.database(
            { code, message: 'synthetic private connection detail', password: 'fictional-secret' },
            DatabaseStage.Connect,
        );
        expect(error.code).toBe('DATABASE_ERROR');
        expect(error.diagnostic).toEqual({ stage: 'CONNECT', reason: code });
        expect(JSON.stringify(error)).not.toContain('synthetic private');
        expect(JSON.stringify(error)).not.toContain('fictional-secret');
    },
);

it('does not expose arbitrary driver codes', () => {
    const error = SafeError.database({ code: 'private arbitrary text' }, DatabaseStage.Execute);
    expect(error.diagnostic).toEqual({ stage: 'EXECUTE', reason: 'UNKNOWN' });
});
