import { spawnDshSandboxTerminal } from "./dsh-sandbox-terminal.mjs";
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { engineSandboxConfiguration, sandboxFileExists } from '@opencraft/sandbox-node/engine';
import { prepareSandboxInvocation } from '@opencraft/sandbox-node/command';

/** Resource confinement follows the engine's existing filesystem/approval policy.
 * The SDK still owns output collection, foreground signals and process lifetime. */
export async function registerDshSubprocessSandbox(ctx) {
  const configuration = await engineSandboxConfiguration();
  if (!configuration) return;
  const bundled = new URL('./sandbox-command.mjs', import.meta.url);
  const runner = fileURLToPath(await sandboxFileExists(bundled) ? bundled : new URL('../../../scripts/server-deployment/sandbox-command.mjs', import.meta.url));
  const require = createRequire(pathToFileURL(process.argv[1]));
  const sdk = require.resolve("@deepseek-ai/dsh-subprocess-local");
  const bundledAgent = new URL("./dsh-terminal-agent.mjs", import.meta.url);
  const agent = fileURLToPath(await sandboxFileExists(bundledAgent) ? bundledAgent : new URL("../../../scripts/server-deployment/dsh-terminal-agent.mjs", import.meta.url));
  const { scrubbedParentEnv } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-subprocess")).href);
  ctx.inject(['subprocess'], scoped => {
    const service = scoped.subprocess;
    const spawn = service.spawn, terminal = service.spawnTerminal;
    const wrap = (spec, tty) => {
      const inherited = { ...scrubbedParentEnv(), ...spec.env };
      const invocation = prepareSandboxInvocation({ runner, configuration, owner: 'dsh', command: spec.argv, cwd: spec.cwd, env: inherited, terminal: tty });
      // SDK merges a scrubbed parent environment. Tombstone it for the controller;
      // the original task environment exists only in its private bounded payload.
      const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), ...invocation.env };
      const stdin = spec.stdio.stdin;
      const stdio = { ...spec.stdio, stdin: stdin === 'pipe' ? 'pipe' : { data: invocation.input + (typeof stdin === 'object' ? stdin.data : '') } };
      return { invocation, spec: { ...spec, stdio, argv: invocation.argv, env, graceMs: Math.max(spec.graceMs ?? 0, 15000) } };
    };
    service.spawn = function(spec) {
      const wrapped = wrap(spec, false);
      const handle = spawn.call(this, wrapped.spec);
      if (spec.stdio.stdin === 'pipe') {
        if (!handle.stdin) { handle.terminate(); throw new Error('Sandbox input transport unavailable'); }
        handle.stdin.write(wrapped.invocation.input, error => { if (error) handle.terminate(); });
      }
      return handle;
    };
    const terminals = new Set();
    service.spawnTerminal = async function(spec) {
      const handle = await spawnDshSandboxTerminal({ runner, configuration, agent, sdk, spec, env: { ...scrubbedParentEnv(), ...spec.env } });
      terminals.add(handle);
      void handle.done.finally(() => terminals.delete(handle)).catch(() => {});
      return handle;
    };
    scoped.on('dispose', async () => { await Promise.all([...terminals].map(handle => handle.terminate())); });
    scoped.on('dispose', () => { service.spawn = spawn; service.spawnTerminal = terminal; });
  });
}
