import { expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const environment of [{ HUSKY: '0' }, { NODE_ENV: 'production' }]) {
    it(`does not import development-only Husky when ${Object.keys(environment)[0]} disables hooks`, () => {
        const artifacts = resolve('.test-artifacts');
        mkdirSync(artifacts, { recursive: true });
        const folder = mkdtempSync(resolve(artifacts, 'prepare-'));
        if (!folder.startsWith(`${artifacts}${sep}`)) throw new Error('Invalid fixture path');
        try {
            mkdirSync(resolve(folder, 'node_modules/husky'), { recursive: true });
            writeFileSync(
                resolve(folder, 'node_modules/husky/package.json'),
                JSON.stringify({ name: 'husky', type: 'module', exports: './index.js' }),
            );
            writeFileSync(
                resolve(folder, 'node_modules/husky/index.js'),
                "export default function husky() {}\nthrow new Error('Development-only dependency was imported');\n",
            );
            copyFileSync(
                resolve('scripts/install-hooks.mjs'),
                resolve(folder, 'install-hooks.mjs'),
            );
            const result = spawnSync(process.execPath, [resolve(folder, 'install-hooks.mjs')], {
                cwd: folder,
                env: environment,
                encoding: 'utf8',
                windowsHide: true,
            });
            expect(result.status, result.stderr).toBe(0);
            expect(result.stderr).not.toContain('Development-only dependency');
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });
}
