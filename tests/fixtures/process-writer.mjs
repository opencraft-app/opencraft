import { acquireProcessWriter } from '../../packages/sqlite-node/src/index.ts';
acquireProcessWriter(process.argv[2]);
process.send('locked');
setInterval(() => {}, 1000);
