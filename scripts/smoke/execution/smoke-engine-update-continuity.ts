import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createManagedWebServer } from '../../web-deployment/server.mjs';
import { packageWebServer } from '../../package-web-server.mjs';
import { startIndependentEngineHost } from '../../server-deployment/engine-host.mjs';
import { startIndependentDshHost } from '../../server-deployment/dsh-host.mjs';
import { attachDshHost } from '../../server-deployment/dsh-host-client.mjs';
import { startHeadlessServer } from '../../headless-application.mjs';
import {
  ModelConfigurationRepository,
  ModelCredentialRepository,
} from '../../../apps/local-agent-host/src/model-config/repository.js';

const run = promisify(execFile);
const announce = async (value: any) => {
  if (process.send) process.send(value);
  else await writeFile(process.argv[4]!, JSON.stringify(value), { mode: 0o600 });
};
const mode = process.argv[2];
if (mode === 'entry') {
  const config = JSON.parse(await readFile(process.argv[3]!, 'utf8'));
  const app = await createManagedWebServer(config);
  const address = await app.listen({ host: '127.0.0.1', port: config.port ?? 0 });
  await announce({ url: 'http://127.0.0.1:' + address.port, adminKeyPath: app.adminKeyPath });
  process.once('SIGTERM', () => void app.close().then(() => process.exit(0)));
} else if (mode === 'gateway') {
  const config = JSON.parse(await readFile(process.argv[3]!, 'utf8'));
  const app = await startHeadlessServer({
    ...config,
    startAgentHost: (options: any) => attachDshHost(config.descriptorPath, options.dataDirectory),
  });
  await announce({ url: app.url });
  process.once('SIGTERM', () => void app.close().then(() => process.exit(0)));
} else if (mode === 'engine-host') {
  const host = await startIndependentEngineHost(JSON.parse(await readFile(process.argv[3]!, 'utf8')));
  await announce({ pid: process.pid });
  process.once('SIGTERM', () => void host.close().then(() => process.exit(0)));
} else if (mode === 'host') {
  const config = JSON.parse(await readFile(process.argv[3]!, 'utf8'));
  const host = await startIndependentDshHost(config);
  await announce({ pid: process.pid, enginePid: host.engineProcessId });
  process.once('SIGTERM', () => void host.close().then(() => process.exit(0)));
} else {
  const directory = await mkdtemp(join(tmpdir(), 'engine-update-continuity-'));
  const report: any[] = [];
  const owned: any[] = [];
  let web: any, socket: WebSocket | undefined;
  let browser: any, page: any;
  let cookie = '';
  let candidate: any;
  let ownerPid: number | null = null;
  let currentTrace = '',
    count = 0;
  const endpoint = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const tool = body.tools?.find((t: any) => t.function?.name === 'bash');
    const invoke = tool && !JSON.stringify(body.messages).includes('continuity-shell-done');
    if (invoke) count++;
    const message = invoke
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'continuity-tool',
              type: 'function',
              function: {
                name: 'bash',
                arguments: JSON.stringify({
                  description: 'Isolated continuity probe',
                  command: `printf 'start\n' >> '${currentTrace}'; sleep ${Number(process.env.CONTINUITY_SECONDS ?? 8)}; printf 'done\n' >> '${currentTrace}'; printf continuity-shell-done`,
                }),
              },
            },
          ],
        }
      : { role: 'assistant', content: tool ? 'continuity-final' : 'Continuity probe' };
    const base = { id: 'fixture', created: 1, model: 'fixture' };
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ...base, choices: [{ message, finish_reason: 'stop' }] }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.end(chunk(message) + chunk({}, invoke ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  const until = async (
    predicate: () => Promise<boolean>,
    label: string,
    ms = Math.max(25000, Number(process.env.CONTINUITY_SECONDS ?? 8) * 1000 + 20000),
  ) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(100);
    }
    throw new Error('Timeout: ' + label);
  };
  const start = async (role: string, path: string) => {
    if (process.env.CONTINUITY_SYSTEMD === '1') {
      const unit = 'oc-continuity-' + role + '-' + randomUUID().slice(0, 8) + '.service',
        readyFile = join(directory, unit + '.ready');
      await run('systemd-run', [
        '--quiet',
        '--collect',
        '--unit=' + unit,
        '--property=WorkingDirectory=' + process.cwd(),
        '--property=KillMode=control-group',
        '--property=TimeoutStopSec=15',
        '--setenv=HOME=' + join(directory, 'home'),
        process.execPath,
        '--import',
        'tsx',
        new URL(import.meta.url).pathname,
        role,
        path,
        readyFile,
      ]);
      const child = { unit };
      owned.push(child);
      await until(
        async () => {
          try {
            await readFile(readyFile);
            return true;
          } catch {
            return false;
          }
        },
        role + ' unit ready',
        45000,
      );
      const ready = JSON.parse(await readFile(readyFile, 'utf8'));
      const pid = Number((await run('systemctl', ['show', unit, '-p', 'MainPID', '--value'])).stdout.trim());
      return { child, ...ready, pid };
    }
    const child = fork(new URL(import.meta.url), [role, path], {
      env: { ...process.env, HOME: join(directory, 'home') },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    owned.push(child);
    let log = '';
    child.stdout?.on('data', (data) => (log += data));
    child.stderr?.on('data', (data) => (log += data));
    const ready: any = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(role + ' startup timeout: ' + log)), 45000);
      child.once('message', (value) => {
        clearTimeout(timer);
        accept(value);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(role + ' exited ' + code + ': ' + log));
      });
    });
    return { child, ...ready };
  };
  const stop = async (child: any) => {
    if (child.unit) {
      if (!child.closed) {
        await run('systemctl', ['stop', child.unit]);
        child.closed = true;
      }
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  };
  let id = 0;
  const rpc = (method: string, params: any = {}) =>
    new Promise<any>((accept, reject) => {
      const target = socket!,
        requestId = ++id;
      const timer = setTimeout(() => {
        target.off('message', receive);
        reject(new Error(method + ' timed out'));
      }, 15000);
      const receive = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString());
        if (frame.id !== requestId) return;
        clearTimeout(timer);
        target.off('message', receive);
        frame.error ? reject(new Error(method + ': ' + frame.error.message)) : accept(frame.result);
      };
      target.on('message', receive);
      target.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
    });
  const connect = async (url: string) => {
    socket = new WebSocket(url.replace('http:', 'ws:') + '/appserver', { origin: url });
    await new Promise<void>((accept, reject) => {
      socket!.once('open', accept);
      socket!.once('error', reject);
    });
    await rpc('initialize');
  };
  try {
    await new Promise<void>((accept) => endpoint.listen(0, '127.0.0.1', accept));
    const models = join(directory, 'data/models');
    await new ModelCredentialRepository(models).set('FIXTURE', 'synthetic-key');
    await new ModelConfigurationRepository(models).initialize({
      schemaVersion: 1,
      revision: 0,
      providers: [
        {
          id: 'fixture',
          name: 'Fixture',
          protocol: 'openai-completions',
          baseUrl: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`,
          credentialRef: 'FIXTURE',
          enabled: true,
          models: [{ id: 'fixture', enabled: true, input: ['text'] }],
        },
      ],
      defaultModel: { providerId: 'fixture', modelId: 'fixture' },
    });
    const webRoot = process.env.CONTINUITY_WEB_ROOT ?? join(directory, 'web');
    await mkdir(webRoot, { recursive: true });
    if (!process.env.CONTINUITY_WEB_ROOT)
      await writeFile(
        join(webRoot, 'index.html'),
        '<!doctype html><meta name="opencraft-build-id" content="continuity-fixture"><title>Continuity probe</title>',
      );
    if (!process.env.CONTINUITY_WEB_ROOT)
      await writeFile(
        join(webRoot, 'version.json'),
        JSON.stringify({
          schemaVersion: 1,
          buildId: 'continuity-fixture',
          headlessServer: true,
          headlessHostId: 'opencraft-server',
        }),
      );
    const localAccessFile = join(directory, 'local-access');
    await writeFile(localAccessFile, 'ab'.repeat(32), { mode: 0o600 });
    const descriptorPath = join(directory, 'host.json'),
      hostConfig = join(directory, 'host-config.json'),
      gatewayConfig = join(directory, 'gateway-config.json');
    await writeFile(
      hostConfig,
      JSON.stringify({
        descriptorPath,
        dataDirectory: join(directory, 'data/agent'),
        modelStorageDirectory: models,
        projectStorageDirectory: join(directory, 'data/projects'),
        runtimeDirectory: directory,
        skillsDirectory: join(directory, 'skills'),
        dshExecutable: resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),
        dshCapabilityPlugin: resolve('apps/local-agent-host/src/dsh-capability-plugin.mjs'),
      }),
    );
    await writeFile(
      gatewayConfig,
      JSON.stringify({
        root: resolve('.'),
        webRoot,
        dataDirectory: join(directory, 'data'),
        runtimeDirectory: directory,
        descriptorPath,
        localAccessFile,
        port: 0,
        engines: ['dsh', 'pi'],
        defaultEngine: 'dsh',
      }),
    );
    const host = await start('host', hostConfig);
    if (process.env.CONTINUITY_INDEPENDENT !== '0') {
      const ownerConfig = join(directory, 'owner-config.json'),
        engineHostDescriptor = join(directory, 'owner.json');
      await writeFile(
        ownerConfig,
        JSON.stringify({
          descriptorPath: engineHostDescriptor,
          dataDirectory: join(directory, 'data'),
          dshDescriptorPath: descriptorPath,
          runtimeDirectory: directory,
          engines: ['dsh', 'pi'],
          defaultEngine: 'dsh',
        }),
      );
      const owner = await start('engine-host', ownerConfig);
      ownerPid = owner.pid;
      console.log(JSON.stringify({ independentPiPid: owner.pid }));
      const config = JSON.parse(await readFile(gatewayConfig, 'utf8'));
      config.engineHostDescriptor = engineHostDescriptor;
      await writeFile(gatewayConfig, JSON.stringify(config));
    }
    let gateway = await start('gateway', gatewayConfig);
    const first = await packageWebServer({ version: '1.0.0', webRoot, output: join(directory, 'release-1') });
    candidate = await packageWebServer({ version: '1.1.0', webRoot, output: join(directory, 'release-2') });
    const entryConfig = join(directory, 'entry-config.json');
    const gatewayOptions = JSON.parse(await readFile(gatewayConfig, 'utf8'));
    gatewayOptions.port = Number(new URL(gateway.url).port);
    await writeFile(gatewayConfig, JSON.stringify(gatewayOptions));
    await writeFile(
      entryConfig,
      JSON.stringify({
        initialRelease: first.packageRoot,
        stateDirectory: join(directory, 'web-state'),
        headlessBackendTarget: gateway.url,
        localAccessFile,
      }),
    );
    const openWeb = async () => {
      web = await start('entry', entryConfig);
      web.close = () => stop(web.child);
      return web.url;
    };
    let url = await openWeb();
    const fixedEntry = JSON.parse(await readFile(entryConfig, 'utf8'));
    fixedEntry.port = Number(new URL(url).port);
    await writeFile(entryConfig, JSON.stringify(fixedEntry));
    if (process.env.CONTINUITY_BROWSER === '1') {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      page = await browser.newPage();
    }
    for (const engine of process.env.CONTINUITY_ENGINE ? [process.env.CONTINUITY_ENGINE] : ['dsh', 'pi'])
      for (const scenario of ['web-hot-update', 'execution-restart', 'entry-restart']) {
        count = 0;
        currentTrace = join(directory, engine + '-' + scenario + '.trace');
        await connect(url);
        const model =
          engine === 'pi'
            ? 'pi:fixture:fixture'
            : (await rpc('model/list')).data.find((m: any) => !m.model.startsWith('pi:')).model;
        const created = await rpc('thread/start', { model, cwd: directory, dynamicTools: [] });
        const threadId = created.thread.id;
        const { turn } = await rpc('turn/start', {
          threadId,
          input: [{ type: 'text', text: 'Run bash once and finish.' }],
        });
        await until(async () => (await readFile(currentTrace, 'utf8').catch(() => '')) === 'start\n', 'tool started');
        if (page) {
          await page.goto(url + '/local/' + encodeURIComponent(threadId) + '?hostId=opencraft-server');
          await page.getByText('Run bash once and finish.', { exact: true }).first().waitFor({ timeout: 20000 });
        }
        const beforeCount = count;
        if (scenario === 'execution-restart') {
          socket!.terminate();
          await stop(gateway.child);
          gateway = await start('gateway', gatewayConfig);
        } else if (scenario === 'entry-restart') {
          socket!.terminate();
          await web.close();
          url = await openWeb();
        } else {
          const post = (action: string, body: any = {}) =>
            fetch(url + '/__opencraft_updates/' + action, {
              method: 'POST',
              headers: { origin: url, 'content-type': 'application/json', cookie },
              body: JSON.stringify(body),
            });
          const login = await post('login', { key: (await readFile(web.adminKeyPath, 'utf8')).trim() });
          assert.equal(login.status, 200);
          cookie = login.headers.get('set-cookie')!.split(';')[0]!;
          let closed = false;
          socket!.once('close', () => (closed = true));
          const action = report.some((row) => row.scenario === 'web-hot-update') ? 'rollback' : 'install-local';
          assert.equal(
            (
              await post(
                action,
                action === 'install-local'
                  ? {
                      archive: candidate.archive,
                      version: candidate.version,
                      buildId: candidate.buildId,
                      integrity: candidate.integrity,
                    }
                  : {},
              )
            ).status,
            202,
          );
          await until(async () => {
            const value = await fetch(url + '/__opencraft_updates', { headers: { cookie } }).then((r) => r.json());
            if (value.job?.phase === 'failed') throw new Error(value.job.error);
            return value.job?.phase === 'completed';
          }, 'real Web update completed');
          assert.equal(closed, false, 'hot update must preserve existing socket');
          socket!.terminate();
        }
        await connect(url);
        await rpc('thread/resume', { threadId });
        let history: any;
        let failure = '';
        try {
          await until(async () => {
            history = (await rpc('thread/read', { threadId, includeTurns: true })).thread;
            return history.turns.some((t: any) => t.id === turn.id && t.status === 'completed');
          }, 'original Turn complete');
        } catch (error) {
          failure = String(error);
        }
        let browserRecovered: boolean | null = null;
        if (page) {
          assert.equal(new URL(page.url()).origin, url, 'fixed entry preserves browser origin');
          try {
            await page.getByText('continuity-final', { exact: true }).first().waitFor({ timeout: 20000 });
            browserRecovered = true;
          } catch {
            browserRecovered = false;
          }
          await page.screenshot({ path: join(directory, engine + '-' + scenario + '.png') });
        }
        const trace = await readFile(currentTrace, 'utf8').catch(() => '');
        const currentHost = await attachDshHost(descriptorPath, join(directory, 'data/agent'));
        assert.equal((await currentHost.getIdentity()).enginePid, host.enginePid);
        if (ownerPid) process.kill(ownerPid, 0);
        const result = {
          ownerPid,
          engine,
          scenario,
          threadId,
          turnId: turn.id,
          hostPid: host.pid,
          enginePid: host.enginePid,
          trace,
          count,
          beforeCount,
          browserRecovered,
          systemd: process.env.CONTINUITY_SYSTEMD === '1',
          passed: !failure && browserRecovered !== false && trace === 'start\ndone\n' && count === 1,
          failure,
          turns: history?.turns.map((t: any) => ({ id: t.id, status: t.status })),
        };
        report.push(result);
        console.log(JSON.stringify(result));
        socket!.terminate();
      }
    await writeFile(process.env.CONTINUITY_REPORT ?? join(directory, 'report.json'), JSON.stringify(report, null, 2));
    assert.ok(
      report.every((row) => row.passed),
      'Continuity matrix has failures',
    );
  } finally {
    await browser?.close();
    socket?.terminate();
    await web?.close();
    for (const child of owned.reverse()) await stop(child);
    endpoint.closeAllConnections();
    await new Promise<void>((accept) => endpoint.close(() => accept()));
    if (process.env.CONTINUITY_KEEP !== '1') await rm(directory, { recursive: true, force: true });
    else console.log('evidence=' + directory);
  }
}
