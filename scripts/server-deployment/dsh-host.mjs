import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { verifyDshOwnerAdmission } from '../patch-dsh-owner-admission.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireLock, bootIdentity } from '../full-upgrade/durable.mjs';
import { inspectOwnerCgroup } from './owner-cgroup.mjs';
import { DshOwnerHandoff } from './dsh-owner-handoff.mjs';
import { readDshColdResources } from './dsh-cold-resources.mjs';
import { mkdir, rename, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLocalAgentStorageOwner, startLocalAgentHost } from '../../apps/local-agent-host/src/main.ts';
import { readDaemonMachineIdentity } from '../../apps/opencraft-daemon/src/machine-identity.ts';
import { readPrivateJson } from './dsh-host-client.mjs';
import { readTaskCoreConversations } from '../tasks-conversation-catalog.mjs';
import { RemoteSessionCapabilities } from '../../packages/session-capabilities/src/remote.ts';

export async function startIndependentDshHost(configuration) {
  const {descriptorPath, machineIdentityDirectory, machineName, taskCodexCoreEndpoint, taskCodexCoreTokenFile, coldDependencyRoots = [], ...options} = configuration;
  if (!isAbsolute(descriptorPath) || !isAbsolute(options.dataDirectory ?? ''))
    throw new Error('Independent DSH Host requires absolute descriptor and data paths');
  if (process.env.OPENCRAFT_DSH_URL?.trim() || options.dshUrl)
    throw new Error('Independent DSH Host must own its engine');
  if (!options.dshExecutable || !options.dshCapabilityPlugin) throw new Error("DSH handoff requires pinned executable and plugin paths");
  await verifyDshOwnerAdmission(resolve(dirname(options.dshExecutable),"../../../.."));
  await mkdir(join(options.dataDirectory,'owner-handoff'),{recursive:true,mode:0o700});
  const releaseKernel = await acquireLock(join(options.dataDirectory,'owner-writer.lock')).catch(error=>{throw new Error('DSH writer already owned or unavailable',{cause:error});});
  let release;
  try { release = await acquireLocalAgentStorageOwner(options.dataDirectory); }
  catch (error) { await releaseKernel(); throw error; }
  let controlServer;
  let agent;
  let closed;
  const temporary = `${descriptorPath}.${randomUUID()}.tmp`;
  try {
  const runtime = {entrySha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    node:process.version,nodeAbi:process.versions.modules,configSha256:createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
    sourceRevision:process.env.OPENCRAFT_OBSERVE_SOURCE_REVISION ?? null,buildId:process.env.OPENCRAFT_OBSERVE_BUILD_ID ?? null};
  const immutableAttachments = new Map();
  for (const path of [process.env.OPENCRAFT_DSH_HOST_CONFIG,taskCodexCoreTokenFile].filter(Boolean))
    immutableAttachments.set(path,createHash('sha256').update(await readFile(path)).digest('hex'));
  const bootId = await bootIdentity();
  const handoff = new DshOwnerHandoff(options.dataDirectory,runtime,inspectOwnerCgroup);
    const machineIdentity = options.machineIdentity ?? await readDaemonMachineIdentity(
      machineIdentityDirectory ?? dirname(options.dataDirectory), machineName);
    options.machineIdentity = machineIdentity;
    runtime.machineId = machineIdentity.machineId;
    const sessionCapabilities = new RemoteSessionCapabilities(dirname(options.dataDirectory), `server:${machineIdentity.machineId}:dsh`);
    options.sessionCapabilities ??= sessionCapabilities;
    options.authorizeHostInput ??= (threadId, inputId) => sessionCapabilities.authorizeInput(threadId, inputId);
    options.modelPolicyPath ??= join(dirname(options.dataDirectory), "model-usage-policy.sqlite");
    options.taskServerId ??= "opencraft-server";
    options.taskSkillDirectories ??= [resolve(options.dataDirectory, "../codex/runtime/skills")];
    if (taskCodexCoreEndpoint || taskCodexCoreTokenFile) {
      if (!isAbsolute(taskCodexCoreEndpoint ?? '') || !isAbsolute(taskCodexCoreTokenFile ?? '')) throw new Error('Task Core catalog requires explicit absolute connection paths');
      const info = await stat(taskCodexCoreTokenFile);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('Task Core catalog requires an owned private token file');
      const token = (await readFile(taskCodexCoreTokenFile, 'utf8')).trim();
      if (!token) throw new Error('Task Core catalog token is empty');
      options.taskConversationCatalog ??= (serverId, search, limit, cursor) => {
        if (serverId !== 'local-codex') throw new Error('Unknown task conversation server');
        return readTaskCoreConversations(taskCodexCoreEndpoint, token, search, limit, cursor);
      };
    }
    await handoff.load();
    agent = await startLocalAgentHost({...options, ownerHandoff:handoff});
    handoff.attach({...agent,
      get engineProcessId() { return agent.engineProcessId; },
      coldReadResources: async () => {
        for (const [path,digest] of immutableAttachments) if (createHash('sha256').update(await readFile(path)).digest('hex') !== digest) throw new Error('DSH configured attachment changed');
        const attachments = {};
        for (const name of ['session-capabilities.json','session-capabilities.key']) {
          const path = join(dirname(options.dataDirectory),name);
          try { await stat(path);attachments[name] = path; } catch(error) {if(error.code !== 'ENOENT') throw error;}
        }
        return readDshColdResources({identity:join(machineIdentityDirectory ?? dirname(options.dataDirectory),"machine-id"),
          dependencyRoots:coldDependencyRoots,agent:options.dataDirectory,models:options.modelStorageDirectory,
          projects:options.projectStorageDirectory,skills:options.skillsDirectory,
          nativeRuntime:resolve(dirname(options.dshExecutable),"../../../.."),plugins:dirname(options.dshCapabilityPlugin),...attachments});
      },
    });
    const controlToken = randomUUID();
    controlServer = createServer((request,response)=>{
      response.setHeader('content-type','application/json'); response.setHeader('cache-control','no-store');
      if (request.method !== 'POST' || request.url !== '/owner-handoff' || request.headers.origin !== undefined || request.headers.authorization !== 'Bearer '+controlToken) {
        response.writeHead(403).end('{}'); return;
      }
      void (async()=>{
        const chunks=[];let size=0;
        for await(const chunk of request) {size+=chunk.length;if(size>32768) throw new Error('Request too large');chunks.push(chunk);}
        const {action,...input}=JSON.parse(Buffer.concat(chunks).toString());
        response.end(JSON.stringify({pid:process.pid,bootId,runtime,...await handoff.control(action,input)}));
      })().catch(()=>{response.writeHead(409).end(JSON.stringify({error:'owner_handoff_rejected'}));});
    });
    await new Promise((resolve,reject)=>{controlServer.once('error',reject);controlServer.listen(0,'127.0.0.1',resolve);});
    const controlUrl = 'http://127.0.0.1:'+controlServer.address().port+'/owner-handoff';
    await mkdir(dirname(descriptorPath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, pid: process.pid, machineId: machineIdentity.machineId,
      dataDirectory: resolve(options.dataDirectory), websocketUrl: agent.websocketUrl, ownerHandoff:{protocol:1,url:controlUrl,token:controlToken} }), { mode: 0o600 });
    await rename(temporary, descriptorPath);
    return { ...agent, handoff,
      get engineProcessId() { return agent.engineProcessId; },
      get engineState() { return agent.engineState; },
      get dshUrl() { return agent.dshUrl; },
      close() {
        return closed ??= (async () => {
          try { await agent.close(); }
          finally { controlServer.closeAllConnections(); await new Promise(resolve=>controlServer.close(resolve)); await rm(descriptorPath, { force: true }); await release(); await releaseKernel(); }
        })();
      } };
  } catch (error) {
    await rm(temporary, { force: true });
    try { await agent?.close(); } finally { controlServer?.close(); await release(); await releaseKernel(); }
    throw error;
  }
}

if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  const config = await readPrivateJson(process.env.OPENCRAFT_DSH_HOST_CONFIG ?? '');
  const host = await startIndependentDshHost({
    ...config,
    taskCodexCoreEndpoint: config.taskCodexCoreEndpoint ?? process.env.OPENCRAFT_CODEX_CORE_ENDPOINT,
    taskCodexCoreTokenFile: config.taskCodexCoreTokenFile ?? process.env.OPENCRAFT_DAEMON_TOKEN_FILE,
  });
  console.log('Independent OpenCraft DSH Host ready');
  const stop = () => void host.close().then(() => process.exit(0), () => process.exit(1));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
