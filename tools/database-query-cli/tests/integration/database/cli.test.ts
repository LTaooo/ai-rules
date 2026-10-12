import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

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
        const list = run(['list']);
        expect(list.status).toBe(0);
        expect(JSON.parse(list.stdout)).toEqual([
            { name: 'local', type: 'sqlite', description: 'Synthetic fixture' },
        ]);
        const schema = run(['describe', '--database', 'local', '--table', 'book']);
        expect(schema.status).toBe(0);
        expect(JSON.parse(schema.stdout).columns).toContain('column_name');
        const count = run(['query', '--database', 'local'], 'SELECT COUNT(*) AS total FROM book');
        expect(count.status).toBe(0);
        expect(JSON.parse(count.stdout).rows).toEqual([['2']]);
        const rejected = run(['query', '--database', 'local'], 'DELETE FROM book');
        expect(rejected.status).toBe(1);
        expect(rejected.stderr.trim()).toBe('SQL_REJECTED');
        expect(rejected.stdout).toBe('');
        const shown = run(['show', '--database', 'local']);
        expect(shown.status).toBe(0);
        const shownSource = JSON.parse(shown.stdout);
        expect(shownSource.filename).toBe(filename);
        expect(shown.stdout).not.toContain('password');
        const filtered = run(['describe', '--database', 'local', '--table-like', 'boo%']);
        expect(filtered.status).toBe(0);
        expect(JSON.parse(filtered.stdout).rowCount).toBeGreaterThan(0);
        const globbed = run(['describe', '--database', 'local', '--table-like', 'boo*']);
        expect(globbed.status).toBe(0);
        expect(JSON.parse(globbed.stdout).rowCount).toBeGreaterThan(0);
        const contains = run(['describe', '--database', 'local', '--table-like', 'book']);
        expect(contains.status).toBe(0);
        expect(JSON.parse(contains.stdout).rowCount).toBeGreaterThan(0);
        const inline = run(
            ['query', '--database', 'local', '--parameters', '[1]'],
            'SELECT id FROM book WHERE id = ?',
        );
        expect(inline.status).toBe(0);
        expect(JSON.parse(inline.stdout).rows).toEqual([['1']]);
        const conflicting = run(
            ['query', '--database', 'local', '--parameters', '[1]', '--parameters-file', 'p.json'],
            'SELECT 1',
        );
        expect(conflicting.status).toBe(1);
        expect(conflicting.stderr.trim()).toBe('INVALID_REQUEST');
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}, 60000);

it('rejects non-interactive init and lists init in help', () => {
    mkdirSync('.test-artifacts', { recursive: true });
    const folder = mkdtempSync(resolve('.test-artifacts/cli-init-'));
    try {
        const help = spawnSync(process.execPath, [resolve('dist/cli.js'), '--help'], {
            encoding: 'utf8',
            timeout: 15000,
        });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('init');
        expect(help.stdout).not.toContain('--config');
        const run = spawnSync(process.execPath, [resolve('dist/cli.js'), 'init'], {
            encoding: 'utf8',
            input: '',
            timeout: 15000,
        });
        expect(run.status).toBe(1);
        expect(run.stderr.trim()).toBe('INVALID_REQUEST');
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}, 60000);
