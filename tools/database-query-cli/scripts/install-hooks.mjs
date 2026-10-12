import { spawnSync } from 'node:child_process';

// HUSKY=0、生产环境或省略开发依赖时跳过钩子安装。
if (
    process.env.HUSKY !== '0' &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.npm_config_omit?.split(',').includes('dev')
) {
    const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (toplevel.status !== 0) {
        console.error(
            'Git hooks not installed: run npm run prepare inside the repository checkout.',
        );
        process.exitCode = 1;
    } else {
        const configured = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
            encoding: 'utf8',
            cwd: toplevel.stdout.trim(),
        });
        if (configured.status !== 0) {
            console.error(configured.stderr);
            process.exitCode = 1;
        }
    }
}
