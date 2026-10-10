import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

it('serves three real stdio MCP tools without stdout log contamination', async () => {
    mkdirSync('.test-artifacts', { recursive: true });
    const folder = mkdtempSync(resolve('.test-artifacts/mcp-'));
    const filename = resolve(folder, 'fixture.sqlite');
    const database = new DatabaseSync(filename);
    database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1)');
    database.close();
    const configPath = resolve(folder, 'databases.json');
    writeFileSync(
        configPath,
        JSON.stringify({
            databases: [
                { name: 'test', type: 'sqlite', description: 'Isolated fixture', filename },
            ],
        }),
    );
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/index.js'), '--config', configPath],
        cwd: folder,
        env: {},
        stderr: 'pipe',
    });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
            'describe_schema',
            'list_databases',
            'query_database',
        ]);
        const list = await client.callTool({ name: 'list_databases', arguments: {} });
        expect(list.structuredContent).toEqual({
            databases: [{ name: 'test', type: 'sqlite', description: 'Isolated fixture' }],
        });
        const query = await client.callTool({
            name: 'query_database',
            arguments: { database: 'test', sql: 'SELECT id FROM users' },
        });
        expect(query.isError).not.toBe(true);
        expect(query.structuredContent).toMatchObject({
            columns: ['id'],
            rows: [['1']],
            rowCount: 1,
            truncated: false,
        });
        const schema = await client.callTool({
            name: 'describe_schema',
            arguments: { database: 'test', table: 'users' },
        });
        expect(schema.isError).not.toBe(true);
        const rejected = await client.callTool({
            name: 'query_database',
            arguments: { database: 'test', sql: 'DROP TABLE users' },
        });
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected)).toContain('SQL_REJECTED');
    } finally {
        await client.close();
        rmSync(folder, { recursive: true, force: true });
    }
}, 20000);
