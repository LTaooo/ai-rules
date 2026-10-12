import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** 可注入的子进程启动函数签名，便于测试替换真实 spawn。 */
export type ProcessSpawner = (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
) => ChildProcess;
