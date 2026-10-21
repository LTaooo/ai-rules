import { Dialect } from '../../../src/domain/enums/Dialect.js';
import { describe, expect, it } from 'vitest';
import { SqlPolicy } from '../../../src/security/SqlPolicy.js';

describe('SQL policy', () => {
    for (const dialect of Object.values(Dialect)) {
        it.each([
            'SELECT 1',
            "SELECT 'DELETE; DROP TABLE users -- /* */' AS text",
            'SELECT id FROM users WHERE id = 1 ORDER BY id LIMIT 3;',
            'SELECT COUNT(*) FROM users',
            'SELECT status, COUNT(*) FROM orders GROUP BY status HAVING COUNT(*) > 1',
            'SELECT DISTINCT id FROM users',
            'SELECT COUNT(DISTINCT id) FROM users',
            'SELECT CASE WHEN id = 1 THEN 2 ELSE 3 END FROM users',
            "SELECT COALESCE(name, 'unknown') FROM users",
            'WITH visible AS (SELECT id FROM users) SELECT id FROM visible',
            'SELECT id FROM users UNION ALL SELECT id FROM archived',
            'SELECT a.id FROM users a JOIN teams b ON a.team_id = b.id',
            'SELECT id FROM users WHERE id IN (SELECT user_id FROM teams)',
            'SELECT id FROM users WHERE EXISTS (SELECT 1 FROM teams WHERE teams.id = users.id)',
            'SELECT id FROM users WHERE NOT EXISTS (SELECT 1 FROM teams WHERE teams.id = users.id)',
            'SELECT SUM(x) OVER (PARTITION BY y ORDER BY z) FROM t',
            'SELECT unknown_udf(id) FROM users',
            'SELECT pg_catalog.lower(name) FROM users',
            'SELECT (SELECT MAX(id) FROM users) AS m FROM users',
        ])(`allows ${dialect}: %s`, (sql) => {
            expect(SqlPolicy.validateSql(sql, dialect)).toBeTruthy();
        });

        it.each([
            'INSERT INTO users VALUES (1)',
            'UPDATE users SET id = 2',
            'DELETE FROM users',
            'DROP TABLE users',
            'ALTER TABLE users ADD COLUMN secret TEXT',
            'CREATE TABLE stolen (id INT)',
            'TRUNCATE TABLE users',
            'GRANT ALL ON users TO attacker',
            'SELECT 1; SELECT 2',
            'SELECT 1; DROP TABLE users',
            'SELECT 1 -- comment',
            'SELECT /* harmless */ 1',
            'SELECT /*!50000 SQL_NO_CACHE */ 1',
            "SELECT load_extension('evil')",
            "SELECT nextval('sequence')",
            "SELECT setval('sequence', 1)",
            "SELECT pg_read_file('/etc/passwd')",
            "SELECT pg_catalog.pg_read_file('/etc/passwd')",
            "SELECT LOAD_FILE('/etc/passwd')",
            'SELECT SLEEP(10)',
            'SELECT BENCHMARK(1000000, MD5(1))',
            "SELECT GET_LOCK('mutex', 10)",
            'SELECT pg_advisory_lock(1)',
            "SELECT dblink_connect('dbname=other')",
            'SELECT 1 FROM users WHERE EXISTS(id)',
            "SELECT 1 FROM users WHERE EXISTS(name LIKE 'a%')",
            'SELECT 1 FROM users WHERE NOT EXISTS(123)',
            'SELECT * FROM users FOR UPDATE',
            'SELECT * FROM users FOR SHARE',
            'SELECT * INTO copied FROM users',
            "SELECT * FROM users INTO OUTFILE '/tmp/stolen'",
            'WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed',
            'WITH x AS (DELETE FROM users) SELECT 1',
            'WITH x AS (INSERT INTO users VALUES (1)) SELECT 1',
            'WITH x AS (UPDATE users SET id = 2) SELECT 1',
            'WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t',
            'SELECT pg_advisory_lock_shared(1)',
            'SELECT pg_try_advisory_lock(1)',
            "SELECT lo_put(1, 0, 'x')",
            'SELECT lo_unlink(1)',
            "SELECT pg_replication_slot_advance('s', '0/0')",
            "SELECT pg_logical_slot_get_changes('s', NULL, NULL)",
            'PRAGMA query_only = OFF',
            "ATTACH DATABASE 'other.db' AS other",
            'VACUUM',
            'SHOW TABLES',
            'EXPLAIN ANALYZE SELECT 1',
            'SELECT @secret := 1',
            'SELECT CAST(1 AS evil_type)',
            "SELECT E'escaped\\string'",
            'SELECT $$quoted$$',
            '',
            'not sql',
        ])(`rejects ${dialect}: %s`, (sql) => {
            expect(() => SqlPolicy.validateSql(sql, dialect)).toThrow();
        });
    }

    it('supports native parameter placeholders', () => {
        expect(SqlPolicy.validateSql('SELECT $1 AS value', Dialect.PostgreSQL)).toBeTruthy();
        expect(SqlPolicy.validateSql('SELECT ? AS value', Dialect.MySQL)).toBeTruthy();
        expect(SqlPolicy.validateSql('SELECT ? AS value', Dialect.SQLite)).toBeTruthy();
    });

    it('rejects oversized SQL', () => {
        expect(() =>
            SqlPolicy.validateSql(`SELECT '${'a'.repeat(65536)}'`, Dialect.SQLite),
        ).toThrow();
    });

    it('rejects deeply nested SQL before parsing', () => {
        expect(() =>
            SqlPolicy.validateSql(`SELECT ${'('.repeat(65)}1${')'.repeat(65)}`, Dialect.SQLite),
        ).toThrow();
    });

    it('supports a quoted identifier and standard casts', () => {
        expect(
            SqlPolicy.validateSql('SELECT "name" FROM "users"', Dialect.PostgreSQL),
        ).toBeTruthy();
        expect(
            SqlPolicy.validateSql('SELECT CAST(id AS TEXT) FROM users', Dialect.SQLite),
        ).toBeTruthy();
    });

    it('rejects the mysql group by modifier while allowing plain group by', () => {
        expect(
            SqlPolicy.validateSql(
                'SELECT status, COUNT(*) FROM orders GROUP BY status',
                Dialect.MySQL,
            ),
        ).toBeTruthy();
        expect(() =>
            SqlPolicy.validateSql(
                'SELECT status, COUNT(*) FROM orders GROUP BY status WITH ROLLUP',
                Dialect.MySQL,
            ),
        ).toThrow();
    });

    it('denies dangerous functions on every dialect without an allowlist', () => {
        expect(
            SqlPolicy.validateSql(
                "SELECT DATE_FORMAT(created_at,'%Y-%m') FROM orders",
                Dialect.MySQL,
            ),
        ).toBeTruthy();
        expect(
            SqlPolicy.validateSql(
                "SELECT DATE_FORMAT(created_at,'%Y-%m') FROM orders",
                Dialect.PostgreSQL,
            ),
        ).toBeTruthy();
        expect(
            SqlPolicy.validateSql('SELECT CHAR_LENGTH(name) FROM users', Dialect.SQLite),
        ).toBeTruthy();
        expect(() =>
            SqlPolicy.validateSql("SELECT LOAD_FILE('/etc/passwd')", Dialect.MySQL),
        ).toThrow();
        expect(() =>
            SqlPolicy.validateSql("SELECT LOAD_FILE('/etc/passwd')", Dialect.SQLite),
        ).toThrow();
    });

    it('allows mysql date arithmetic and window functions', () => {
        expect(
            SqlPolicy.validateSql('SELECT NOW() - INTERVAL 7 DAY FROM orders', Dialect.MySQL),
        ).toBeTruthy();
        expect(
            SqlPolicy.validateSql(
                'SELECT DATE_ADD(created_at, INTERVAL 1 DAY) FROM orders',
                Dialect.MySQL,
            ),
        ).toBeTruthy();
        expect(
            SqlPolicy.validateSql(
                'SELECT ROW_NUMBER() OVER (ORDER BY id) FROM users',
                Dialect.MySQL,
            ),
        ).toBeTruthy();
    });

    it('rejects mysql-only syntax the parser cannot express', () => {
        // 索引提示不被 node-sql-parser 识别，语法层即拒绝；上游支持前无法放行。
        expect(() =>
            SqlPolicy.validateSql('SELECT id FROM users FORCE INDEX (idx_users)', Dialect.MySQL),
        ).toThrow();
        expect(() =>
            SqlPolicy.validateSql('SELECT id FROM users LOCK IN SHARE MODE', Dialect.MySQL),
        ).toThrow();
    });

    it('allows mysql date grouping and correlated exists subqueries', () => {
        expect(
            SqlPolicy.validateSql(
                "SELECT DATE_FORMAT(o.created_at,'%Y-%m') AS ym, COUNT(*) AS cnt FROM orders o WHERE o.status=3 AND o.updated_by<>'System' AND o.created_at>'2026-03-01' GROUP BY ym ORDER BY ym",
                Dialect.MySQL,
            ),
        ).toBeTruthy();
        expect(
            SqlPolicy.validateSql(
                "SELECT o.id AS order_id, o.customer_id, o.created_at FROM orders o WHERE o.status=3 AND o.updated_by<>'System' AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.deleted=0 AND i.product_id IS NOT NULL AND i.product_id<>'') AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id=o.id)",
                Dialect.MySQL,
            ),
        ).toBeTruthy();
    });
});
