import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

function readResult(run: SpawnSyncReturns<string>, ok: boolean): unknown {
    expect(run.status).toBe(ok ? 0 : 1);
    expect(ok ? run.stderr : run.stdout).toBe('');
    const lines = (ok ? run.stdout : run.stderr).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    const response = JSON.parse(lines[0]!);
    expect(Object.keys(response).sort()).toEqual(['ok', 'result']);
    expect(response.ok).toBe(ok);
    return response.result;
}

it('runs compiled CLI list, describe, count and rejects writes against injected test sources', () => {
    mkdirSync('.test-artifacts', { recursive: true });
    const folder = mkdtempSync(resolve('.test-artifacts/cli-'));
    const filename = resolve(folder, 'test.sqlite');
    try {
        const database = new DatabaseSync(filename);
        database.exec(
            'CREATE TABLE book (id INTEGER PRIMARY KEY); INSERT INTO book VALUES (1), (2);',
        );
        database.close();
        const sources = JSON.stringify([
            { name: 'local', type: 'sqlite', description: 'Synthetic fixture', filename },
        ]);
        const env = { ...process.env, DATABASE_QUERY_TEST_SOURCES: sources };
        const run = (args: string[], input?: string) =>
            spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {
                encoding: 'utf8',
                input,
                timeout: 15000,
                env,
            });
        expect(readResult(run(['list']), true)).toEqual([
            { name: 'local', type: 'sqlite', description: 'Synthetic fixture' },
        ]);
        const schema = run(['describe', '--database', 'local', '--table', 'book']);
        expect(readResult(schema, true)).toMatchObject({
            columns: expect.arrayContaining(['column_name']),
        });
        const count = run(['query', '--database', 'local'], 'SELECT COUNT(*) AS total FROM book');
        expect(readResult(count, true)).toMatchObject({ rows: [['2']], truncated: false });
        const limited = run(
            ['query', '--database', 'local', '--max-rows', '1'],
            'SELECT id FROM book ORDER BY id',
        );
        expect(readResult(limited, true)).toMatchObject({ rowCount: 1, truncated: true });
        const rejected = run(['query', '--database', 'local'], 'DELETE FROM book');
        expect(readResult(rejected, false)).toMatchObject({
            code: 'SQL_REJECTED',
            reason: 'policy_denied',
        });
        const shown = run(['show', '--database', 'local']);
        expect(readResult(shown, true)).toMatchObject({ filename });
        expect(shown.stdout).not.toContain('password');
        for (const pattern of ['boo%', 'boo*', 'book']) {
            const filtered = run(['describe', '--database', 'local', '--table-like', pattern]);
            expect(readResult(filtered, true)).toMatchObject({ rowCount: 1 });
        }
        const inline = run(
            ['query', '--database', 'local', '--parameters', '[1]'],
            'SELECT id FROM book WHERE id = ?',
        );
        expect(readResult(inline, true)).toMatchObject({ rows: [['1']] });
        const conflicting = run(
            ['query', '--database', 'local', '--parameters', '[1]', '--parameters-file', 'p.json'],
            'SELECT 1',
        );
        expect(conflicting.status).toBe(1);
        expect(conflicting.stderr).toMatch(/"code":"INVALID_REQUEST"/);
        const conflictingWithSql = run(
            [
                'query',
                '--database',
                'local',
                '--sql-file',
                '-',
                '--parameters',
                '[1]',
                '--parameters-file',
                'p.json',
            ],
            'SELECT 1',
        );
        expect(conflictingWithSql.status).toBe(1);
        expect(conflictingWithSql.stderr).toMatch(/"code":"INVALID_REQUEST"/);
        const bothStdin = run(
            ['query', '--database', 'local', '--sql-file', '-', '--parameters-file', '-'],
            'SELECT 1',
        );
        expect(bothStdin.status).toBe(1);
        expect(bothStdin.stderr).toMatch(/"code":"INVALID_REQUEST"/);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}, 60000);

it('rejects non-interactive init and edit and lists both in help', () => {
    mkdirSync('.test-artifacts', { recursive: true });
    const folder = mkdtempSync(resolve('.test-artifacts/cli-init-'));
    try {
        const help = spawnSync(process.execPath, [resolve('dist/cli.js'), '--help'], {
            encoding: 'utf8',
            timeout: 15000,
        });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('init');
        expect(help.stdout).toContain('edit');
        expect(help.stdout).not.toContain('--config');
        const run = spawnSync(process.execPath, [resolve('dist/cli.js'), 'init'], {
            encoding: 'utf8',
            input: '',
            timeout: 15000,
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toMatch(/"code":"INVALID_REQUEST"/);
        const edit = spawnSync(process.execPath, [resolve('dist/cli.js'), 'edit'], {
            encoding: 'utf8',
            input: '',
            timeout: 15000,
        });
        expect(edit.status).toBe(1);
        expect(edit.stderr).toMatch(/"code":"INVALID_REQUEST"/);
        expect(edit.stdout).toBe('');
        const editWithFlag = spawnSync(
            process.execPath,
            [resolve('dist/cli.js'), 'edit', '--database', 'local'],
            { encoding: 'utf8', input: '', timeout: 15000 },
        );
        expect(editWithFlag.status).toBe(1);
        expect(editWithFlag.stderr).toMatch(/"code":"INVALID_REQUEST"/);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}, 60000);
