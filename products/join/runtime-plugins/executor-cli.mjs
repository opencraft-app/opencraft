import {main} from './executor.mjs';

// Explicit executable wrapper: importing the executor library never starts a service.
await main();
