import { DatabaseConfig } from '../../../src/domain/models/DatabaseConfig.js';
import { Dialect } from '../../../src/domain/enums/Dialect.js';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import mysql from 'mysql2';
import { expect, it, vi } from 'vitest';
import { MysqlAdapter } from '../../../src/infrastructure/database/mysql/MysqlAdapter.js';

function packet(payload: Buffer, sequence: number): Buffer {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = sequence;
    return Buffer.concat([header, payload]);
}

async function bounded<Value>(operation: Promise<Value>): Promise<Value> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('Local socket test deadline exceeded')),
                    4000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

it.each([
    ['timeout', '5.6.51'],
    ['close', '5.6.51'],
    ['timeout', '8.0.40'],
    ['close', '8.0.40'],
] as const)(
    'destroys the real MySQL socket after %s on %s without leaving a half-open connection',
    async (mode, version) => {
        const clientSockets: Socket[] = [];
        const serverSockets = new Set<Socket>();
        let prepareCount = 0;
        const statements: string[] = [];
        let adapter: MysqlAdapter | undefined;
        const greeting = Buffer.concat([
            Buffer.from([10]),
            Buffer.from(`${version}\0`),
            Buffer.from([1, 0, 0, 0]),
            Buffer.from('abcdefgh'),
            Buffer.from([0, 0x0d, 0xa2, 45, 2, 0, 0, 0, 0]),
            Buffer.alloc(10),
            Buffer.from('ijklmnopqrst\0'),
        ]);
        const ok = Buffer.from([0, 0, 0, 2, 0, 0, 0]);
        const server = createServer({ allowHalfOpen: true }, (socket) => {
            serverSockets.add(socket);
            socket.on('error', () => {});
            socket.once('close', () => serverSockets.delete(socket));
            let received = Buffer.alloc(0);
            let authenticated = false;
            socket.on('data', (chunk: Buffer) => {
                received = Buffer.concat([received, chunk]);
                while (received.length >= 4) {
                    const length = received.readUIntLE(0, 3);
                    if (received.length < length + 4) break;
                    const payload = received.subarray(4, length + 4);
                    received = received.subarray(length + 4);
                    if (!authenticated) {
                        authenticated = true;
                        socket.write(packet(ok, 2));
                    } else if (payload[0] === 0x03) {
                        const sql = payload.subarray(1).toString('utf8');
                        statements.push(sql);
                        if (sql === 'SELECT VERSION()') {
                            const field = Buffer.concat([
                                Buffer.from([3]),
                                Buffer.from('def'),
                                Buffer.from([0, 0, 0, 9]),
                                Buffer.from('VERSION()'),
                                Buffer.from([0]),
                                Buffer.from([12, 45, 0, 64, 0, 0, 0, 253, 0, 0, 0, 0, 0]),
                            ]);
                            const eof = Buffer.from([0xfe, 0, 0, 2, 0]);
                            socket.write(
                                Buffer.concat([
                                    packet(Buffer.from([1]), 1),
                                    packet(field, 2),
                                    packet(eof, 3),
                                    packet(
                                        Buffer.concat([
                                            Buffer.from([version.length]),
                                            Buffer.from(version),
                                        ]),
                                        4,
                                    ),
                                    packet(eof, 5),
                                ]),
                            );
                        } else {
                            socket.write(packet(ok, 1));
                        }
                    } else if (payload[0] === 0x16) {
                        prepareCount++;
                    }
                }
            });
            socket.write(packet(greeting, 0));
        });
        const createConnection = mysql.createConnection;
        const capture = vi.spyOn(mysql, 'createConnection').mockImplementation((options) => {
            const connection = createConnection(options);
            clientSockets.push((connection as unknown as { stream: Socket }).stream);
            return connection;
        });
        try {
            await bounded(
                new Promise<void>((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(0, '127.0.0.1', resolve);
                }),
            );
            const port = (server.address() as AddressInfo).port;
            adapter = new MysqlAdapter(
                new DatabaseConfig({
                    name: 'fake',
                    type: Dialect.MySQL,
                    host: '127.0.0.1',
                    port,
                    username: 'fake-reader',
                    password: 'fake-password',
                    database: 'fake',
                }),
            );
            const outcome = adapter
                .query('SELECT 1', [], {
                    maxRows: 1,
                    maxConcurrency: 1,
                    maxResponseBytes: 1024,
                    timeoutMs: mode === 'timeout' ? 1000 : 2000,
                })
                .then(
                    () => ({ code: 'UNEXPECTED_SUCCESS' }),
                    (error: unknown) => error,
                );
            await expect.poll(() => prepareCount, { timeout: 800 }).toBe(1);
            expect(clientSockets).toHaveLength(1);
            expect(statements).toContain('SET SESSION TRANSACTION READ ONLY');
            expect(statements).toContain('START TRANSACTION READ ONLY');
            expect(statements.some((sql) => sql.includes('MAX_EXECUTION_TIME'))).toBe(
                version.startsWith('8.'),
            );
            if (mode === 'close') await bounded(adapter.close());
            await expect(bounded(outcome)).resolves.toMatchObject({
                code: mode === 'timeout' ? 'TIMEOUT' : 'CLOSED',
            });
            expect
                .soft(clientSockets[0]!.destroyed, 'socket must be destroyed after cancellation')
                .toBe(true);
            await bounded(adapter.close());
            expect
                .soft(clientSockets[0]!.destroyed, 'socket must stay destroyed after adapter.close')
                .toBe(true);
        } finally {
            capture.mockRestore();
            for (const socket of clientSockets) socket.destroy();
            for (const socket of serverSockets) socket.destroy();
            if (server.listening) {
                await bounded(
                    new Promise<void>((resolve, reject) => {
                        server.close((error) => (error ? reject(error) : resolve()));
                    }),
                );
            }
            if (adapter) await bounded(adapter.close());
        }
    },
    10000,
);
