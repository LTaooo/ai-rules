import { spawn } from 'node:child_process';
import { CredentialFailure } from '../../domain/enums/CredentialFailure.js';
import { ErrorCode } from '../../domain/enums/ErrorCode.js';
import { DatabaseConfig } from '../../domain/models/DatabaseConfig.js';
import type { SourceRegistry } from '../../domain/ports/SourceRegistry.js';
import type { SourceWriter } from '../../domain/ports/SourceWriter.js';
import { SourceSchema } from '../config/SourceSchema.js';
import { SafeError } from '../../shared/errors/SafeError.js';
import type { ProcessSpawner } from './ProcessSpawner.js';

/** 数据源凭据的统一目标名前缀，别名紧跟其后。 */
export const SOURCE_TARGET_PREFIX = 'database-query.';

export class WindowsCredentialStore implements SourceRegistry, SourceWriter {
    private static readonly payloadPattern = /^ok:([A-Za-z0-9+/]+={0,2})$/;
    private static readonly errorPattern = /^err:(\S+)$/;
    /** 凭据读写的常量脚本；模式、目标名与数据均从标准输入读取，argv 不含任何用户数据。 */
    private static readonly script = [
        "$ErrorActionPreference = 'Stop'",
        '$mode = [Console]::In.ReadLine()',
        "Add-Type -TypeDefinition @'",
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class DatabaseQueryCredMan {',
        '    [StructLayout(LayoutKind.Sequential)]',
        '    public struct CREDENTIAL {',
        '        public uint Flags;',
        '        public uint Type;',
        '        public IntPtr TargetName;',
        '        public IntPtr Comment;',
        '        public long LastWritten;',
        '        public uint CredentialBlobSize;',
        '        public IntPtr CredentialBlob;',
        '        public uint Persist;',
        '        public uint AttributeCount;',
        '        public IntPtr Attributes;',
        '        public IntPtr TargetAlias;',
        '        public IntPtr UserName;',
        '    }',
        '    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
        '    public static extern bool CredReadW(string target, uint type, uint reserved, out IntPtr credential);',
        '    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
        '    public static extern bool CredWriteW(ref CREDENTIAL credential, uint reserved);',
        '    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
        '    public static extern bool CredEnumerateW(string filter, uint reserved, out uint count, out IntPtr credentials);',
        '    [DllImport("advapi32.dll")]',
        '    public static extern void CredFree(IntPtr credential);',
        '    public static byte[] ReadBlob(IntPtr pointer) {',
        '        CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));',
        '        byte[] bytes = new byte[credential.CredentialBlobSize];',
        '        Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);',
        '        return bytes;',
        '    }',
        '    public static string ReadTarget(IntPtr array, uint index) {',
        '        IntPtr item = Marshal.ReadIntPtr(array, (int)(index * Marshal.SizeOf(typeof(IntPtr))));',
        '        CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));',
        '        return Marshal.PtrToStringUni(credential.TargetName);',
        '    }',
        '    public static byte[] ReadBlobAt(IntPtr array, uint index) {',
        '        IntPtr item = Marshal.ReadIntPtr(array, (int)(index * Marshal.SizeOf(typeof(IntPtr))));',
        '        CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));',
        '        byte[] bytes = new byte[credential.CredentialBlobSize];',
        '        Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);',
        '        return bytes;',
        '    }',
        '    public static bool WriteBlob(string target, byte[] bytes) {',
        '        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);',
        '        Marshal.Copy(bytes, 0, blob, bytes.Length);',
        '        IntPtr name = Marshal.StringToHGlobalUni(target);',
        '        try {',
        '            CREDENTIAL credential = new CREDENTIAL();',
        '            credential.Type = 1;',
        '            credential.Persist = 2;',
        '            credential.TargetName = name;',
        '            credential.CredentialBlobSize = (uint)bytes.Length;',
        '            credential.CredentialBlob = blob;',
        '            return CredWriteW(ref credential, 0);',
        '        } finally {',
        '            Marshal.FreeHGlobal(blob);',
        '            Marshal.FreeHGlobal(name);',
        '        }',
        '    }',
        '}',
        "'@",
        "if ($mode -eq 'read') {",
        '    $target = [Console]::In.ReadLine()',
        '    $pointer = [IntPtr]::Zero',
        '    if (-not [DatabaseQueryCredMan]::CredReadW($target, 1, 0, [ref]$pointer)) {',
        "        [Console]::Out.Write('err:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())",
        '        exit 0',
        '    }',
        '    try {',
        '        $bytes = [DatabaseQueryCredMan]::ReadBlob($pointer)',
        "        [Console]::Out.Write('ok:' + [Convert]::ToBase64String($bytes))",
        '    } finally {',
        '        [DatabaseQueryCredMan]::CredFree($pointer)',
        '    }',
        '    exit 0',
        '}',
        "if ($mode -eq 'write') {",
        '    $target = [Console]::In.ReadLine()',
        '    $bytes = [Convert]::FromBase64String([Console]::In.ReadLine())',
        '    if (-not [DatabaseQueryCredMan]::WriteBlob($target, $bytes)) {',
        "        [Console]::Out.Write('err:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())",
        '        exit 0',
        '    }',
        "    [Console]::Out.Write('ok:e30=')",
        '    exit 0',
        '}',
        "if ($mode -eq 'list') {",
        '    $filter = [Console]::In.ReadLine()',
        '    $count = [uint32]0',
        '    $array = [IntPtr]::Zero',
        '    if (-not [DatabaseQueryCredMan]::CredEnumerateW($filter, 0, [ref]$count, [ref]$array)) {',
        '        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
        '        if ($code -eq 1168) {',
        "            [Console]::Out.Write('ok:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('[]')))",
        '            exit 0',
        '        }',
        "        [Console]::Out.Write('err:' + $code)",
        '        exit 0',
        '    }',
        '    try {',
        '        $items = @()',
        '        for ($index = 0; $index -lt $count; $index++) {',
        '            $bytes = [DatabaseQueryCredMan]::ReadBlobAt($array, [uint32]$index)',
        '            $target = [DatabaseQueryCredMan]::ReadTarget($array, [uint32]$index)',
        '            $items += @{ target = $target; payload = [Convert]::ToBase64String($bytes) }',
        '        }',
        '        $json = ConvertTo-Json -InputObject @($items) -Compress',
        "        if (-not $json) { $json = '[]' }",
        "        [Console]::Out.Write('ok:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
        '    } finally {',
        '        [DatabaseQueryCredMan]::CredFree($array)',
        '    }',
        '    exit 0',
        '}',
        "    [Console]::Out.Write('err:BADMODE')",
        '    exit 0',
    ].join('\n');

    /** 注入子进程启动函数、超时与输出上限，保持默认值开箱可用。 */
    constructor(
        private readonly spawnChild: ProcessSpawner = spawn,
        private readonly timeoutMs: number = 10000,
        private readonly maxOutputBytes: number = 65536,
    ) {}

    /** 按别名读取并校验数据源配置；别名不存在时抛出 NotFound。 */
    public async get(name: string): Promise<DatabaseConfig> {
        if (!SourceSchema.namePattern.test(name)) throw new SafeError(ErrorCode.NotFound);
        let payload: string;
        try {
            payload = await this.request('read', SOURCE_TARGET_PREFIX + name);
        } catch (error) {
            if (this.isNotFound(error)) throw new SafeError(ErrorCode.NotFound);
            throw error;
        }
        return SourceSchema.parse(Buffer.from(payload, 'base64').toString('utf8'));
    }

    /** 枚举前缀下的全部数据源凭据，解析失败的无关条目被跳过。 */
    public async list(): Promise<DatabaseConfig[]> {
        const payload = await this.request('list', SOURCE_TARGET_PREFIX + '*');
        let items: { target?: unknown; payload?: unknown }[] = [];
        try {
            const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown;
            if (Array.isArray(decoded)) items = decoded as typeof items;
        } catch {
            throw SafeError.credential(CredentialFailure.Invalid);
        }
        const sources: DatabaseConfig[] = [];
        for (const item of items) {
            const target = typeof item.target === 'string' ? item.target : '';
            const data = typeof item.payload === 'string' ? item.payload : '';
            if (!target.startsWith(SOURCE_TARGET_PREFIX)) continue;
            const name = target.slice(SOURCE_TARGET_PREFIX.length);
            if (!SourceSchema.namePattern.test(name)) continue;
            try {
                sources.push(SourceSchema.parse(Buffer.from(data, 'base64').toString('utf8')));
            } catch {
                continue;
            }
        }
        return sources;
    }

    /** 将数据源完整配置 JSON 写入凭据管理器目标，blob 为 UTF-8 字节。 */
    public async write(target: string, payload: string): Promise<void> {
        if (
            !target.startsWith(SOURCE_TARGET_PREFIX) ||
            !SourceSchema.namePattern.test(target.slice(SOURCE_TARGET_PREFIX.length))
        ) {
            throw new SafeError(ErrorCode.ConfigError);
        }
        await this.request('write', target, Buffer.from(payload, 'utf8').toString('base64'));
    }

    /** 以带标签单通道协议与 PowerShell 子进程通信，模式与数据全部经标准输入传递。 */
    private async request(
        mode: 'read' | 'write' | 'list',
        target: string,
        payload?: string,
    ): Promise<string> {
        return new Promise<string>((resolveRequest, rejectRequest) => {
            const child = this.spawnChild(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-EncodedCommand',
                    Buffer.from(WindowsCredentialStore.script, 'utf16le').toString('base64'),
                ],
                { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
            );
            const chunks: Buffer[] = [];
            let bytes = 0;
            let settled = false;
            const settle = (action: () => void): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                action();
            };
            child.stdout?.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > this.maxOutputBytes) {
                    child.kill('SIGKILL');
                    settle(() => rejectRequest(SafeError.credential(CredentialFailure.Invalid)));
                    return;
                }
                chunks.push(chunk);
            });
            child.on('error', () =>
                settle(() => rejectRequest(SafeError.credential(CredentialFailure.Platform))),
            );
            child.on('close', (code) =>
                settle(() => {
                    if (code !== 0) {
                        rejectRequest(SafeError.credential(CredentialFailure.Platform));
                        return;
                    }
                    const output = Buffer.concat(chunks).toString('utf8').trim();
                    const ok = WindowsCredentialStore.payloadPattern.exec(output);
                    if (ok) {
                        resolveRequest(ok[1] ?? '');
                        return;
                    }
                    const failure = WindowsCredentialStore.errorPattern.exec(output);
                    rejectRequest(
                        SafeError.credential(
                            failure ? this.fail(failure[1] ?? '') : CredentialFailure.Platform,
                        ),
                    );
                }),
            );
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                settle(() => rejectRequest(SafeError.credential(CredentialFailure.Timeout)));
            }, this.timeoutMs);
            child.stdin?.on('error', () => undefined);
            child.stdin?.end(mode + '\n' + target + '\n' + (payload ?? '') + '\n');
        });
    }

    /** 将脚本错误标记映射为安全原因类别，不透出原始系统信息。 */
    private fail(raw: string): CredentialFailure {
        if (raw === '1168') {
            return CredentialFailure.NotFound;
        }
        if (raw === '5') {
            return CredentialFailure.AccessDenied;
        }
        if (raw === 'EMPTY') {
            return CredentialFailure.Invalid;
        }
        return CredentialFailure.Platform;
    }

    /** 判断错误是否为“目标不存在”，供注册表转换为 NotFound。 */
    private isNotFound(error: unknown): boolean {
        return (
            error instanceof SafeError &&
            error.code === ErrorCode.CredentialError &&
            error.diagnostic?.reason === CredentialFailure.NotFound
        );
    }
}
