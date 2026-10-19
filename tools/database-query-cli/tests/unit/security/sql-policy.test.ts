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
            "SELECT pg_read_file('/etc/passwd')",
            'SELECT malicious_function(id) FROM users',
            'SELECT ABS(malicious_function(id)) FROM users',
            'SELECT 1 FROM users WHERE EXISTS(id)',
            "SELECT 1 FROM users WHERE EXISTS(name LIKE 'a%')",
            'SELECT 1 FROM users WHERE NOT EXISTS(123)',
            'SELECT pg_catalog.lower(name) FROM users',
            'SELECT * FROM users FOR UPDATE',
            'SELECT * FROM users FOR SHARE',
            'SELECT * INTO copied FROM users',
            "SELECT * FROM users INTO OUTFILE '/tmp/stolen'",
            'WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed',
            'WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t',
            'PRAGMA query_only = OFF',
            "ATTACH DATABASE 'other.db' AS other",
            'VACUUM',
            'SHOW TABLES',
            'EXPLAIN ANALYZE SELECT 1',
            'SELECT @secret := 1',
            'SELECT SLEEP(10)',
            'SELECT * FROM malicious_function()',
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

    it('rejects functions outside the dialect allowlist', () => {
        expect(
            SqlPolicy.validateSql(
                "SELECT DATE_FORMAT(created_at,'%Y-%m') FROM orders",
                Dialect.MySQL,
            ),
        ).toBeTruthy();
        expect(() =>
            SqlPolicy.validateSql(
                "SELECT DATE_FORMAT(created_at,'%Y-%m') FROM orders",
                Dialect.PostgreSQL,
            ),
        ).toThrow();
        expect(() =>
            SqlPolicy.validateSql(
                "SELECT DATE_FORMAT(created_at,'%Y-%m') FROM orders",
                Dialect.SQLite,
            ),
        ).toThrow();
        expect(
            SqlPolicy.validateSql('SELECT CHAR_LENGTH(name) FROM users', Dialect.MySQL),
        ).toBeTruthy();
        expect(
            SqlPolicy.validateSql('SELECT CHAR_LENGTH(name) FROM users', Dialect.PostgreSQL),
        ).toBeTruthy();
        expect(() =>
            SqlPolicy.validateSql('SELECT CHAR_LENGTH(name) FROM users', Dialect.SQLite),
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
