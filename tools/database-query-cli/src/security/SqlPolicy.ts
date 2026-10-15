import { ErrorCode } from '../domain/enums/ErrorCode.js';
import sqlParser from 'node-sql-parser';
import { SafeError } from '../shared/errors/SafeError.js';
import { Dialect } from '../domain/enums/Dialect.js';

const parser = new sqlParser.Parser();
const functions = new Set([
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'COALESCE',
    'NULLIF',
    'LOWER',
    'UPPER',
    'LENGTH',
    'CHAR_LENGTH',
    'ABS',
    'ROUND',
    'TRIM',
    'LTRIM',
    'RTRIM',
    'SUBSTR',
    'SUBSTRING',
    'CONCAT',
]);
const types = new Set([
    'select',
    'expr',
    'column_ref',
    'binary_expr',
    'unary_expr',
    'aggr_func',
    'function',
    'expr_list',
    'number',
    'bool',
    'null',
    'single_quote_string',
    'double_quote_string',
    'default',
    'star',
    'origin',
    'var',
    'cast',
    'case',
    'when',
    'else',
    'ASC',
    'DESC',
    'DISTINCT',
]);
/**
 * AST 键白名单，与 package.json 精确锁定的 node-sql-parser 版本输出一一对应。
 * 升级解析器视为安全事件：未列入的新键默认拒绝，逐键重审本清单并同步安全测试后方可加入。
 */
const keys = new Set([
    'type',
    'with',
    'options',
    'distinct',
    'columns',
    'into',
    'from',
    'where',
    'groupby',
    'having',
    'orderby',
    'limit',
    'window',
    'for_update',
    'locking_read',
    'collate',
    '_next',
    'set_op',
    'expr',
    'as',
    'table',
    'db',
    'column',
    'name',
    'value',
    'args',
    'over',
    'operator',
    'left',
    'right',
    'ast',
    'tableList',
    'columnList',
    'stmt',
    'join',
    'on',
    'using',
    'seperator',
    'separator',
    'nulls',
    'prefix',
    'members',
    // MySQL 方言的 groupby 节点固定携带 modifiers 键，无子句修饰时为 [null]；
    // 非 null 值是 WITH ROLLUP 的 origin 节点，仍被 origin 白名单规则拒绝。
    'modifiers',
    'quoted',
    'keyword',
    'symbol',
    'target',
    'dataType',
    'length',
    'parentheses',
    'parenthesis',
    'cond',
    'result',
    'position',
]);
const operators = new Set([
    '=',
    '!=',
    '<>',
    '<',
    '<=',
    '>',
    '>=',
    '+',
    '-',
    '*',
    '/',
    '%',
    'AND',
    'OR',
    'IS',
    'IS NOT',
    'IN',
    'NOT IN',
    'LIKE',
    'NOT LIKE',
    'BETWEEN',
    'NOT BETWEEN',
    '||',
]);
const castTypes = new Set([
    'TEXT',
    'CHAR',
    'VARCHAR',
    'INT',
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'NUMERIC',
    'DECIMAL',
    'REAL',
    'FLOAT',
    'DOUBLE',
    'BOOLEAN',
    'BOOL',
    'DATE',
    'TIMESTAMP',
    'SIGNED',
    'UNSIGNED',
]);

// 正向白名单：解析器节点与函数不在清单内的一律拒绝。

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

    /** 递归验证 SQL AST 的键、节点、操作符和函数；超出白名单或深度即拒绝。 */
    private static visit(value: unknown, dialect: Dialect, depth: number): void {
        if (depth > 64) SqlPolicy.reject();
        if (value === null || value === undefined || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            for (const child of value) SqlPolicy.visit(child, dialect, depth + 1);
            return;
        }
        const node = SqlPolicy.record(value);
        for (const key of Object.keys(node)) if (!keys.has(key)) SqlPolicy.reject();
        if (
            node.type !== undefined &&
            node.type !== null &&
            (typeof node.type !== 'string' || !types.has(node.type))
        )
            SqlPolicy.reject();
        for (const key of ['options', 'window', 'for_update', 'locking_read', 'collate', 'over'])
            if (node[key] !== undefined && node[key] !== null) SqlPolicy.reject();
        if (node.into !== undefined && node.into !== null) {
            const into = SqlPolicy.record(node.into);
            if (Object.keys(into).length !== 1 || into.position !== null) SqlPolicy.reject();
        }
        if (
            node.operator !== undefined &&
            (typeof node.operator !== 'string' ||
                (!operators.has(node.operator.toUpperCase()) &&
                    !['NOT', '+', '-'].includes(String(node.operator).toUpperCase())))
        )
            SqlPolicy.reject();
        if (
            node.join !== undefined &&
            ![
                'JOIN',
                'INNER JOIN',
                'LEFT JOIN',
                'LEFT OUTER JOIN',
                'RIGHT JOIN',
                'RIGHT OUTER JOIN',
                'FULL JOIN',
                'FULL OUTER JOIN',
                'CROSS JOIN',
            ].includes(String(node.join))
        )
            SqlPolicy.reject();
        if (
            node.set_op !== undefined &&
            !['union', 'union all', 'intersect', 'except'].includes(
                String(node.set_op).toLowerCase(),
            )
        )
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
            let name = node.name;
            if (typeof name !== 'string') {
                const parts = SqlPolicy.record(name).name;
                if (!Array.isArray(parts) || parts.length !== 1) SqlPolicy.reject();
                const part = SqlPolicy.record(parts[0]);
                if (part.type !== 'default') SqlPolicy.reject();
                name = part.value;
            }
            if (typeof name !== 'string' || !functions.has(name.toUpperCase())) SqlPolicy.reject();
        }
        if (node.dataType !== undefined && !castTypes.has(String(node.dataType).toUpperCase()))
            SqlPolicy.reject();
        for (const child of Object.values(node)) SqlPolicy.visit(child, dialect, depth + 1);
    }

    /**
     * 以词法检查和 AST 正向白名单验证单条只读 SELECT；未知语法、函数与写入全部拒绝。
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
