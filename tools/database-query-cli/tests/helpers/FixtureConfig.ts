import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigLoader } from '../../src/infrastructure/config/ConfigLoader.js';

/** 将测试内虚构连接信息写为临时 JSON，加载后立即清理；不读取进程环境。 */
export function fixtureConfig(settings: Record<string, string>): ReturnType<ConfigLoader['load']> {
    mkdirSync('.test-artifacts', { recursive: true });
    const folder = mkdtempSync(resolve('.test-artifacts/fixture-config-'));
    const databases = Object.entries(settings)
        .filter(([key]) => key.startsWith('DB_') && key.endsWith('_URL'))
        .map(([key, value]) => {
            const url = new URL(value);
            const common = {
                name: key.slice(3, -4).toLowerCase(),
                description: 'Synthetic fixture',
            };
            if (url.protocol === 'sqlite:')
                return {
                    ...common,
                    type: 'sqlite',
                    filename: fileURLToPath(value.replace(/^sqlite:/, 'file:')),
                };
            return {
                ...common,
                type: url.protocol === 'mysql:' ? 'mysql' : 'postgres',
                host: url.hostname,
                port: Number(url.port || (url.protocol === 'mysql:' ? 3306 : 5432)),
                database: url.pathname.slice(1),
                username: decodeURIComponent(url.username),
                password: decodeURIComponent(url.password),
                ...(url.protocol === 'mysql:' ? { tls: false } : { sslMode: 'disable' }),
            };
        });
    const limits = Object.fromEntries(
        Object.entries({
            maxRows: 'MCP_DB_MAX_ROWS',
            timeoutMs: 'MCP_DB_QUERY_TIMEOUT_MS',
            maxResponseBytes: 'MCP_DB_MAX_RESPONSE_BYTES',
            maxConcurrency: 'MCP_DB_MAX_CONCURRENCY',
        })
            .filter(([, key]) => settings[key] !== undefined)
            .map(([key, variable]) => [key, Number(settings[variable])]),
    );
    try {
        writeFileSync(resolve(folder, 'config.json'), JSON.stringify({ databases, limits }));
        return new ConfigLoader('config.json', folder).load();
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}
