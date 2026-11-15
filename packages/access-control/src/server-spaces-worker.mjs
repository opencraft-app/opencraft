import { register } from 'tsx/esm/api';
register();
await import('./server-spaces.worker.ts');
