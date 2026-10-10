import { describe, expect, it } from 'vitest';
import { ConfigLoader } from '../../../src/infrastructure/config/ConfigLoader.js';
import { QueryService } from '../../../src/application/QueryService.js';

// 仅显式独立 JSON 路径可启用；默认 npm test/check 清除该变量，绝不读取旧 URL。
const filename = process.env.MCP_TEST_DATABASE_CONFIG;
describe.skipIf(!filename)('explicit isolated external JSON database', () => {
    it('queries only separately supplied isolated read-only accounts', async () => {
        const config = new ConfigLoader(filename!).load();
        const service = new QueryService(config);
        try {
            for (const database of config.databases) {
                const result = await service.query({
                    database: database.name,
                    sql: 'SELECT 1 AS value',
                });
                expect(result.rowCount).toBe(1);
                expect(result.truncated).toBe(false);
                expect((await service.describe({ database: database.name })).columns).toContain(
                    'table_name',
                );
                await expect(
                    service.query({ database: database.name, sql: 'DELETE FROM users' }),
                ).rejects.toThrow('SQL_REJECTED');
            }
        } finally {
            await service.close();
        }
    }, 15000);
});
