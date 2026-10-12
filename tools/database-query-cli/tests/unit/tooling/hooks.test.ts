import { afterEach, describe, expect, it } from 'vitest';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const artifacts = resolve('.test-artifacts');
mkdirSync(artifacts, { recursive: true });
const folders: string[] = [];
afterEach(() => {
    for (const folder of folders.splice(0)) {
        if (!folder.startsWith(`${artifacts}${sep}`)) throw new Error('Invalid fixture path');
        rmSync(folder, { recursive: true, force: true });
    }
});

function fixture(code: string) {
    const folder = mkdtempSync(resolve(artifacts, 'hooks-'));
    folders.push(folder);
    const project = resolve(folder, 'tools/database-query-cli');
    const execute = (command: string, arguments_: string[]) =>
        spawnSync(command, arguments_, { cwd: folder, encoding: 'utf8', windowsHide: true });
    expect(execute('git', ['init', '--quiet']).status).toBe(0);
    mkdirSync(resolve(folder, '.githooks'), { recursive: true });
    copyFileSync(
        resolve(root, '..', '..', '.githooks', 'pre-commit'),
        resolve(folder, '.githooks', 'pre-commit'),
    );
    mkdirSync(project, { recursive: true });
    symlinkSync(
        resolve(root, 'node_modules'),
        resolve(project, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    copyFileSync(resolve(root, '.prettierrc.json'), resolve(project, '.prettierrc.json'));
    copyFileSync(resolve(root, 'eslint.config.mjs'), resolve(project, 'eslint.config.mjs'));
    const projectPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
        'lint-staged': unknown;
    };
    writeFileSync(
        resolve(project, 'package.json'),
        JSON.stringify({
            private: true,
            type: 'module',
            scripts: { typecheck: 'tsc --noEmit --strict --skipLibCheck source.ts' },
            'lint-staged': projectPackage['lint-staged'],
        }),
    );
    writeFileSync(resolve(project, 'source.ts'), code);
    expect(execute('git', ['add', 'tools/database-query-cli/source.ts']).status).toBe(0);
    const gitPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
    const shell = process.platform === 'win32' ? resolve(gitPath, '../../../bin/sh.exe') : 'sh';
    return { folder, execute, run: () => execute(shell, ['.githooks/pre-commit']) };
}

describe('pre-commit script without creating commits', () => {
    it('routes tools changes through the project checks', async () => {
        const { folder, execute, run } = fixture('export const answer=1\n');
        writeFileSync(
            resolve(folder, 'tools/database-query-cli/source.ts'),
            'export const answer=1\nexport const localOnly=2\n',
        );
        const result = run();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(execute('git', ['show', ':tools/database-query-cli/source.ts']).stdout).toBe(
            'export const answer = 1;\n',
        );
        expect(
            readFileSync(resolve(folder, 'tools/database-query-cli/source.ts'), 'utf8'),
        ).toContain('localOnly');
        expect(result.stdout).toContain('tools/database-query-cli');
    }, 30000);

    it('returns failure for lint errors', () => {
        const { run } = fixture('const unused = 1;\n');
        const result = run();
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('no-unused-vars');
    }, 30000);

    it('returns failure for TypeScript errors', () => {
        const { run } = fixture("export const answer: number = 'wrong';\n");
        const result = run();
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('TS2322');
    }, 30000);

    it('ignores credential and SQLite sidecar patterns but retains the example', () => {
        const { folder, execute } = fixture('export const answer = 1;\n');
        copyFileSync(resolve(root, '.gitignore'), resolve(folder, '.gitignore'));
        expect(
            execute('git', ['check-ignore', '.env', '.env.production', 'data.sqlite-wal'])
                .stdout.trim()
                .split(/\r?\n/),
        ).toEqual(['.env', '.env.production', 'data.sqlite-wal']);
        expect(execute('git', ['check-ignore', '.env.example']).status).toBe(1);
        expect(existsSync(resolve(root, '.agentsignore'))).toBe(false);
    });
});
