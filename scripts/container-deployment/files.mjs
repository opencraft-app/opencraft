import { startHostFileSystem, createHostFileSystem } from '../../apps/headless-server/src/host-filesystem.ts';
import { deploymentPaths } from './paths.mjs';
const paths = deploymentPaths();
const options = { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken };
if (process.argv.includes('--probe')) {
  const client = createHostFileSystem(options);
  try { await client.probe(); } finally { client.close(); }
} else {
  const owner = await startHostFileSystem(options);
  let closing;
  const stop = () => closing ??= owner.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void stop(); });
  if (process.argv.includes('--supervised')) { process.stdin.resume(); process.stdin.once('end', () => { void stop(); }); }
  console.log(JSON.stringify({ type: 'opencraft-hands-filesystem-ready', pid: process.pid }));
}
