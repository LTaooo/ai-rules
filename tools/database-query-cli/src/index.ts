import { Application } from './bootstrap/Application.js';

void new Application().run().catch((error: unknown) => Application.failure(error));
