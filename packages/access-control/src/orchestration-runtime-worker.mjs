// Source bootstrap. Packaged gateways ship the bundled worker under this name.
import { register } from 'tsx/esm/api';
register();
await import('./orchestration-runtime.worker.ts');
