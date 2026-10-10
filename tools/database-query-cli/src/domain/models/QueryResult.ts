export type Parameter = string | number | boolean | null;

export interface RawResult {
    columns: string[];
    rows: unknown[][];
}

export interface QueryResult extends RawResult {
    rowCount: number;
    truncated: boolean;
    durationMs: number;
}
