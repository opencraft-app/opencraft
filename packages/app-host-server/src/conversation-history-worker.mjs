// Source checkout bootstrap; packages contain the standalone bundled worker.
import { register } from 'tsx/esm/api';
register();
await import('./conversation-history-storage.worker.mjs');
