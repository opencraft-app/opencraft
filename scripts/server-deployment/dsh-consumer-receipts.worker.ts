import { parentPort, workerData } from 'node:worker_threads';
import { ConsumerReceiptRejection, DshConsumerReceiptStore } from './dsh-consumer-receipts-store.js';
if (!parentPort) throw new Error('DSH consumer receipts require a Worker');
const port = parentPort;
const store = new DshConsumerReceiptStore(workerData.directory);
port.postMessage({ id: 0, ...store.observation });
port.on('message', ({ id, method, args }) => {
  try {
    if (!Array.isArray(args) || !['begin', 'finish', 'acknowledge', 'close'].includes(method)) throw new Error('Invalid consumer storage operation');
    if (method === 'close') { store.close(); port.postMessage({ id }); port.close(); return; }
    const result = Reflect.apply(store[method as 'begin' | 'finish' | 'acknowledge'], store, args);
    port.postMessage({ id, result, ...store.observation });
  } catch (error) {
    const recoverable = error instanceof ConsumerReceiptRejection;
    if (!recoverable) { try { store.close(); } catch {} }
    port.postMessage({ id, error: { message: (error as Error).message, recoverable } });
    if (!recoverable) port.close();
  }
});
