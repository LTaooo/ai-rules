/** 查询限制集合，全部数据源共用内置安全默认值。 */
export interface Limits {
    maxRows: number;
    timeoutMs: number;
    maxResponseBytes: number;
    maxConcurrency: number;
}
