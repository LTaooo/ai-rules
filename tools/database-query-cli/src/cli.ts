import { DatabaseCli } from './presentation/cli/DatabaseCli.js';

const status = await new DatabaseCli().run();
process.exitCode = status;
