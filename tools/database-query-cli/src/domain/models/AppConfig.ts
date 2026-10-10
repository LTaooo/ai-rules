import { DatabaseConfig } from './DatabaseConfig.js';

export interface Limits {
    maxRows: number;
    timeoutMs: number;
    maxResponseBytes: number;
    maxConcurrency: number;
}

export class AppConfig {
    /** 初始化依赖与资源状态，不在构造期间执行查询。 */
    constructor(
        public readonly databases: DatabaseConfig[],
        public readonly limits: Limits,
    ) {}
}
