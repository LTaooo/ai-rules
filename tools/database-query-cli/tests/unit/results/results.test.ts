import { expect, it } from 'vitest';
import { ResultProcessor } from '../../../src/shared/results/ResultProcessor.js';

it('normalizes dates, binary, JSON, exact numbers and non-finite database values', () => {
    expect(ResultProcessor.normalize(new Date('2026-10-09T00:00:00Z'))).toBe(
        '2026-10-09T00:00:00.000Z',
    );
    expect(ResultProcessor.normalize(Buffer.from('hello'))).toEqual({
        type: 'binary',
        base64: 'aGVsbG8=',
    });
    expect(ResultProcessor.normalize({ nested: [9007199254740993n, null] })).toEqual({
        nested: ['9007199254740993', null],
    });
    expect(ResultProcessor.normalize('1234567890.123456789')).toBe('1234567890.123456789');
    expect(ResultProcessor.normalize(Infinity)).toBe('Infinity');
});
