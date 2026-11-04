import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { DurableHostProcessService } from '../../../apps/local-agent-host/src/durable-process-service.js';
const environment = {
  snapshot(scope: any) { return { owner: JSON.stringify([scope.account, scope.hostId, scope.projectId]),
    apply: (base: any) => ({ ...base, TERMINAL_TEST_VALUE: scope.account + ':' + scope.projectId }),
    overlay: () => ({ TERMINAL_TEST_VALUE: scope.account + ':' + scope.projectId }),
  }; },
} as any;
const service = new DurableHostProcessService(process.argv[2]!, environment);
service.subscribe((method, params) => process.send?.({ method, params }));
process.on('message', async (message: any) => {
  try { process.send?.({ id: message.id, result: await service.dispatch(message.method, message.params, message.scope) }); }
  catch (error) { process.send?.({ id: message.id, error: (error as Error).message }); }
});
process.once('disconnect', () => { service.close(); process.exit(0); });
if (process.argv[3] === '--http') {
  const endpoint = process.argv[4]!;
  await unlink(endpoint).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; if (text.length > 2 * 1024 * 1024) request.destroy(); });
    request.on('end', async () => {
      try { const message = JSON.parse(text); response.end(JSON.stringify({ result: await service.dispatch(message.method, message.params, message.scope) })); }
      catch { response.statusCode = 400; response.end('{}'); }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  await chmod(endpoint, 0o600);
  process.once('SIGTERM', () => { service.close(); server.close(() => process.exit(0)); });
} else process.send?.({ ready: true });
