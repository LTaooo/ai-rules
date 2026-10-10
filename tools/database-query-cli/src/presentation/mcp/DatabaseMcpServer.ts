import { ToolName } from '../../domain/enums/ToolName.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SafeError } from '../../shared/errors/SafeError.js';
import { ResultProcessor } from '../../shared/results/ResultProcessor.js';
import { describeInput, queryInput, QueryService } from '../../application/QueryService.js';

const resultSchema = z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
    rowCount: z.number().int(),
    truncated: z.boolean(),
    durationMs: z.number(),
});
const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};

export class DatabaseMcpServer {
    /** 根据已验证配置构造对应组件，不解析连接 URL。 */
    public static create(service: QueryService): McpServer {
        const server = new McpServer({ name: 'database-query-mcp', version: '0.1.0' });
        const respond = async (action: () => Promise<Record<string, unknown>>) => {
            try {
                const result = await action();
                const response = {
                    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                    structuredContent: result,
                };
                ResultProcessor.checkBytes(response, service.maxResponseBytes);
                return response;
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: SafeError.from(error).code }],
                };
            }
        };
        server.registerTool(
            ToolName.ListDatabases,
            {
                description: 'List configured database aliases without connection details.',
                inputSchema: z.object({}).strict(),
                outputSchema: z.object({
                    databases: z.array(
                        z.object({
                            name: z.string(),
                            type: z.string(),
                            description: z.string().optional(),
                        }),
                    ),
                }),
                annotations,
            },
            () => respond(async () => ({ databases: service.listDatabases() })),
        );
        server.registerTool(
            ToolName.DescribeSchema,
            {
                description:
                    'Read table and column metadata. SQLite has no schema parameter; MySQL is restricted to its configured database.',
                inputSchema: describeInput,
                outputSchema: resultSchema,
                annotations,
            },
            (input) => respond(async () => ({ ...(await service.describe(input)) })),
        );
        server.registerTool(
            ToolName.QueryDatabase,
            {
                description:
                    'Execute a single read-only SELECT or SELECT-only WITH query. PostgreSQL placeholders: $1; MySQL/SQLite: ?. Unknown functions and SQL syntax are rejected.',
                inputSchema: queryInput,
                outputSchema: resultSchema,
                annotations,
            },
            (input) => respond(async () => ({ ...(await service.query(input)) })),
        );
        return server;
    }
}
