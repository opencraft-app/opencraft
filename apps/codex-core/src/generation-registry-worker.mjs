import {register} from 'tsx/esm/api';
register();
await import('./generation-registry.worker.ts');
