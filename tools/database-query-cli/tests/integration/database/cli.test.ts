import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('runs compiled CLI list, describe, count and rejects writes against isolated SQLite', () => {
    mkdirSync('.test-artifacts', { recursive: true });
    const folder = mkdtempSync(resolve('.test-artifacts/cli-'));
    const filename = resolve(folder, 'test.sqlite');
    const config = resolve(folder, 'config.json');
    try {
        const database = new DatabaseSync(filename);
        database.exec(
            'CREATE TABLE book (id INTEGER PRIMARY KEY); INSERT INTO book VALUES (1), (2);',
        );
        database.close();
        writeFileSync(
            config,
            JSON.stringify({
                databases: [
                    { name: 'local', type: 'sqlite', description: 'Synthetic fixture', filename },
                ],
            }),
        );
        const run = (args: string[], input?: string) =>
            spawnSync(process.execPath, [resolve('dist/cli.js'), ...args, '--config', config], {
                encoding: 'utf8',
                input,
                timeout: 15000,
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
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}, 60000);
