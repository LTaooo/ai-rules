import { spawnSync } from 'node:child_process';

// 默认检查绝不启用外部数据库集成，即使调用者设置了测试变量。
const environment = { ...process.env };
delete environment.DATABASE_QUERY_TEST_SOURCES;
const result = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)],
    { env: environment, stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
