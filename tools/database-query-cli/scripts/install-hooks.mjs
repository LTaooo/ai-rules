import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (
    process.env.HUSKY !== '0' &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.npm_config_omit?.split(',').includes('dev')
) {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (result.status !== 0 || !existsSync('.git')) {
        console.error(
            'Git hooks not installed: initialize this project as a Git repository, then run npm run prepare.',
        );
    } else {
        const { default: husky } = await import('husky');
        const message = husky();
        if (message) {
            console.error(message);
            process.exitCode = 1;
        }
    }
}
