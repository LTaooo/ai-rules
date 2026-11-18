export interface SourceRemover {
    /** 删除指定目标名的数据源凭据；目标不存在时抛出 NotFound。 */
    remove(target: string): Promise<void>;
}
