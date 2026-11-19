import { parentPort } from 'node:worker_threads';
import { rewriteGrasp } from './grasp-rewrite.js';

if (!parentPort) throw new Error('Grasp rewriting requires a Worker');
parentPort.on('message', async ({ id, source, type, path }: { id: number; source: string; type: string; path: string }) => {
  try { parentPort!.postMessage({ id, body: await rewriteGrasp(source, type, path) }); }
  catch { parentPort!.postMessage({ id, error: true }); }
});
