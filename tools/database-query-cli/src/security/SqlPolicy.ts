import { ErrorCode } from '../domain/enums/ErrorCode.js';
import sqlParser from 'node-sql-parser';
import { SafeError } from '../shared/errors/SafeError.js';
import { Dialect } from '../domain/enums/Dialect.js';

const parser = new sqlParser.Parser();

/**
 * 危险函数黑名单，全方言统一，按函数最终标识符的大写形式匹配，限定名取最后一段。
 * 枚举覆盖只读查询语境中的写副作用与资源滥用面：文件与服务器状态读取、休眠消耗、
 * 锁获取与后端控制、序列推进、扩展加载与跨库通道；新条目须同步安全测试方可加入。
 */
const deniedFunctions = new Set([
    'DBLINK',
    'DBLINK_CANCEL_QUERY',
    'DBLINK_CONNECT',
    'DBLINK_ERROR_MESSAGE',
    'DBLINK_EXEC',
    'DBLINK_GET_NOTIFY',
    'DBLINK_GET_RESULT',
    'DBLINK_IS_BUSY',
    'DBLINK_SEND_QUERY',
    'BENCHMARK',
    'GET_LOCK',
    'IS_FREE_LOCK',
    'IS_USED_LOCK',
    'LOAD_EXTENSION',
    'LOAD_FILE',
    'LO_CREAT',
    'LO_CREATE',
    'LO_EXPORT',
    'LO_FROM_BYTEA',
    'LO_IMPORT',
    'LO_PUT',
    'LO_UNLINK',
    'NEXTVAL',
    'PG_ADVISORY_LOCK',
    'PG_ADVISORY_LOCK_SHARED',
    'PG_ADVISORY_UNLOCK',
    'PG_ADVISORY_UNLOCK_ALL',
    'PG_ADVISORY_UNLOCK_SHARED',
    'PG_ADVISORY_XACT_LOCK',
    'PG_ADVISORY_XACT_LOCK_SHARED',
    'PG_CANCEL_BACKEND',
    'PG_CURRENT_LOGFILE',
    'PG_LS_DIR',
    'PG_LOGICAL_SLOT_GET_CHANGES',
    'PG_LOGICAL_SLOT_PEEK_CHANGES',
    'PG_READ_BINARY_FILE',
    'PG_READ_FILE',
    'PG_RELOAD_CONF',
    'PG_REPLICATION_SLOT_ADVANCE',
    'PG_ROTATE_LOGFILE',
    'PG_TRY_ADVISORY_LOCK',
    'PG_TRY_ADVISORY_LOCK_SHARED',
    'PG_TRY_ADVISORY_XACT_LOCK',
    'PG_TRY_ADVISORY_XACT_LOCK_SHARED',
    'PG_SLEEP',
    'PG_SLEEP_FOR',
    'PG_SLEEP_UNTIL',
    'PG_STAT_FILE',
    'PG_TERMINATE_BACKEND',
    'RELEASE_ALL_LOCKS',
    'RELEASE_LOCK',
    'SETVAL',
    'SLEEP',
]);
/**
 * 非 SELECT 语句与写副作用节点的类型禁令，出现即拒绝；枚举对应锁定的
 * node-sql-parser 5.4.0 语法，升级解析器时重新核对。匹配区分大小写，
 * 语句类型 'desc' 因此不会误伤排序方向的 'DESC' 节点。
 */
const deniedTypes = new Set([
    'insert',
    'update',
    'delete',
    'replace',
    'create',
    'alter',
    'drop',
    'truncate',
    'grant',
    'revoke',
    'rename',
    'call',
    'set',
    'use',
    'lock',
    'unlock',
    'show',
    'explain',
    'transaction',
    'desc',
    'load_data',
    'declare',
    'copy',
    'do',
    'kill',
    'analyze',
    'optimize',
    'handler',
    'help',
    'assign',
]);
/** 值非空即表示锁定读取或 RETURNING 子句的键；二者只属于写入与锁场景。 */
const deniedValueKeys = ['for_update', 'locking_read', 'returning'];

export class SqlPolicy {
    /** 终止不可信 SQL 的验证，仅抛出不包含 SQL 的安全错误。 */
    private static reject(): never {
        throw new SafeError(ErrorCode.SqlRejected);
    }
    /** 要求 AST 节点为对象，拒绝 null、数组和其他非法节点。 */
    private static record(value: unknown): Record<string, unknown> {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            return SqlPolicy.reject();
        return value as Record<string, unknown>;
    }

    /** 要求节点是携带 SELECT AST 的子查询。 */
    private static requireSubquery(value: unknown): void {
        const subquery = SqlPolicy.record(value);
        if (!('ast' in subquery)) return SqlPolicy.reject();
        if (SqlPolicy.record(subquery.ast).type !== 'select') return SqlPolicy.reject();
    }

    /** 要求 EXISTS 的参数是恰好一个子查询。 */
    private static requireExistsSubquery(args: unknown): void {
        const list = SqlPolicy.record(args);
        if (list.type !== 'expr_list') return SqlPolicy.reject();
        const values = list.value;
        if (!Array.isArray(values) || values.length !== 1) return SqlPolicy.reject();
        SqlPolicy.requireSubquery(values[0]);
    }

    /** 提取函数名的最后一段标识符；限定名与带引号名防止引用样式绕过黑名单。 */
    private static finalIdentifier(name: unknown): string {
        const parts = SqlPolicy.record(name).name;
        if (!Array.isArray(parts) || parts.length === 0) return SqlPolicy.reject();
        const part = SqlPolicy.record(parts[parts.length - 1]);
        const value: unknown = part.value;
        if (typeof value !== 'string') return SqlPolicy.reject();
        return value;
    }

    /** 拒绝注释、反斜杠、异常引号、多语句和过深括号，消除方言解析歧义。 */
    private static checkLexical(sql: string): string {
        if (Buffer.byteLength(sql) > 65536 || !sql.trim()) SqlPolicy.reject();
        let quote = '';
        let depth = 0;
        let ended = false;
        for (let index = 0; index < sql.length; index++) {
            const character = sql[index]!;
            // 反斜杠与注释在各方言中有不同的转义规则，直接拒绝以消除解析歧义。
            if (character === '\\' || character === '\0') SqlPolicy.reject();
            if (quote) {
                if (character === quote) {
                    if (sql[index + 1] === quote) index++;
                    else quote = '';
                }
                continue;
            }
            if (ended && !/\s/.test(character)) SqlPolicy.reject();
            if (character === "'" || character === '"' || character === '`') quote = character;
            else if (
                character === '#' ||
                (character === '-' && sql[index + 1] === '-') ||
                (character === '/' && sql[index + 1] === '*')
            )
                SqlPolicy.reject();
            else if (character === ';') ended = true;
            else if (character === '(' && ++depth > 64) SqlPolicy.reject();
            else if (character === ')') depth--;
            else if (character === '$' && !/[0-9]/.test(sql[index + 1] ?? '')) SqlPolicy.reject();
        }
        if (quote || depth !== 0) SqlPolicy.reject();
        return sql.trim().replace(/;$/, '').trim();
    }

    /** 递归检查 SQL AST：语句形态契约与危险黑名单之外一律放行，交给数据库解释。 */
    private static visit(value: unknown, dialect: Dialect, depth: number): void {
        if (depth > 64) SqlPolicy.reject();
        if (value === null || value === undefined || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            for (const child of value) SqlPolicy.visit(child, dialect, depth + 1);
            return;
        }
        const node = SqlPolicy.record(value);
        // 子查询包装必须携带 SELECT；CTE 体的语句节点则由 deniedTypes 拦截，
        // 该禁令与包装形状无关，覆盖两种方言不同的 CTE 结构。
        if ('ast' in node) SqlPolicy.requireSubquery(node);
        for (const key of deniedValueKeys)
            if (node[key] !== undefined && node[key] !== null) SqlPolicy.reject();
        // WITH RECURSIVE 在只读服务中无正当用途，递归标记出现即拒绝。
        if (node.recursive !== undefined && node.recursive !== null) SqlPolicy.reject();
        if (node.into !== undefined && node.into !== null) {
            const into = SqlPolicy.record(node.into);
            if (Object.keys(into).length !== 1 || into.position !== null) SqlPolicy.reject();
        }
        // 会话变量赋值以 assign 节点或 := 操作符两种形状出现，均拒绝。
        if (typeof node.type === 'string' && deniedTypes.has(node.type)) SqlPolicy.reject();
        if (typeof node.operator === 'string' && node.operator.toUpperCase() === ':=')
            SqlPolicy.reject();
        if (dialect !== Dialect.PostgreSQL && node.db) SqlPolicy.reject();
        if (node.type === 'origin' && node.value !== '?') SqlPolicy.reject();
        if (
            node.type === 'var' &&
            !(
                dialect === Dialect.PostgreSQL &&
                node.prefix === '$' &&
                Number.isInteger(node.name) &&
                Number(node.name) > 0 &&
                !node.quoted &&
                Array.isArray(node.members) &&
                node.members.length === 0
            )
        )
            SqlPolicy.reject();
        if (node.type === 'function' || node.type === 'aggr_func') {
            const raw = node.name;
            const name = typeof raw === 'string' ? raw : SqlPolicy.finalIdentifier(raw);
            if (deniedFunctions.has(name.toUpperCase())) return SqlPolicy.reject();
            if (name.toUpperCase() === 'EXISTS') SqlPolicy.requireExistsSubquery(node.args);
        }
        for (const child of Object.values(node)) SqlPolicy.visit(child, dialect, depth + 1);
    }

    /**
     * 以词法检查、SELECT 语句类型和危险黑名单验证单条只读语句；写入与注入面形状拒绝，
     * 其余语法交给数据库解释，由只读账户、只读事务和执行超时兜底。
     * @param dialect 数据源方言，决定 AST 校验规则。
     * @returns 规范化后的 SQL 文本（去除尾部分号）。
     */
    public static validateSql(sql: string, dialect: Dialect): string {
        try {
            const clean = SqlPolicy.checkLexical(sql);
            const parsed: unknown = parser.astify(clean, {
                database: { sqlite: 'SQLite', postgres: 'Postgresql', mysql: 'MySQL' }[dialect],
            });
            const statement = Array.isArray(parsed)
                ? parsed.length === 1
                    ? parsed[0]
                    : SqlPolicy.reject()
                : parsed;
            if (SqlPolicy.record(statement).type !== 'select') SqlPolicy.reject();
            SqlPolicy.visit(statement, dialect, 0);
            return clean;
        } catch {
            return SqlPolicy.reject();
        }
    }
}
