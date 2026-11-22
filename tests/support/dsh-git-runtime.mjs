import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, isBuiltin } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { patchDshGitExecution } from "../../scripts/postinstall/patch-dsh-git-execution.mjs";
import { patchDshThreadEnvironment } from "../../scripts/postinstall/patch-dsh-thread-environment.mjs";

/** Load the exact pinned SDK, transforming isolated copies only. The installed
 * reference remains read-only; subprocess/PTY lifetime stays with the SDK. */
export async function dshGitRuntime(t) {
  const installed = process.env.OPENCRAFT_DSH_RUNTIME;
  assert(installed, "OPENCRAFT_DSH_RUNTIME must name an installed pinned runtime");
  const lock = JSON.parse(await readFile(new URL("../../runtime/dsh/package.json", import.meta.url), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "dsh-git-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = ["dsh-tool-bash", "dsh-terminal-bash", "dsh-bash-local"];
  for (const name of entries) {
    const source = join(installed, `node_modules/@deepseek-ai/${name}`);
    assert.equal(
      JSON.parse(await readFile(join(source, "package.json"), "utf8")).version,
      lock.dependencies["@deepseek-ai/dsh"],
    );
    const target = join(root, `node_modules/@deepseek-ai/${name}/lib/index.js`);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, await readFile(join(source, "lib/index.js")));
  }
  await patchDshThreadEnvironment(root);
  await patchDshGitExecution(root);
  const require = createRequire(join(installed, "package.json"));
  const load = async (name) => {
    const reference = require.resolve(`@deepseek-ai/${name}`);
    const entry = entries.includes(name) ? join(root, `node_modules/@deepseek-ai/${name}/lib/index.js`) : reference;
    const output = join(root, `${name}.mjs`);
    await build({
      stdin: { contents: await readFile(entry, "utf8"), resolveDir: join(reference, ".."), sourcefile: reference },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: output,
      logLevel: "silent",
      plugins: [
        {
          name: "installed-sdk-graph",
          setup(builder) {
            // Preserve the SDK's actual package identities and native-addon paths;
            // only the entry whose async boundary changed is transformed.
            builder.onResolve({ filter: /^[^./]/ }, (args) => ({
              path: isBuiltin(args.path) ? args.path : require.resolve(args.path),
              external: true,
            }));
          },
        },
      ],
    });
    return import(pathToFileURL(output).href);
  };
  const [bash, terminal, executor] = await Promise.all([
    load("dsh-tool-bash"),
    load("dsh-terminal-bash"),
    load("dsh-bash-local"),
  ]);
  // Keep native addons and the subprocess owner in the same installed graph.
  const { LocalSubprocessRuntime } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-subprocess-local")).href
  );
  return { bash, terminal, executor, LocalSubprocessRuntime };
}

/** Actual SDK lifecycle methods with an isolated registry/context fixture. No
 * substitute spawn implementation and no production runtime mutation. */
export function dshGitContext(sdk, root, port) {
  const subprocess = Object.assign(Object.create(sdk.LocalSubprocessRuntime.prototype), {
    live: new Set(),
    terminals: new Set(),
    internals: {},
  });
  let tool;
  const jobs = [];
  const ctx = {
    subprocess,
    get(name) {
      return name === "opencraftExecutionThread" ? port() : name === "jobs" ? this.jobs : undefined;
    },
    on() {},
    terminals: { hasOwnerActivity: () => false },
    sandboxPolicy: {
      defaultMode: "danger-full-access",
      resolve: () => ({ mode: "danger-full-access", workspaceRoot: root }),
    },
    shellEnv: {
      collect: (exec) => ({ DSH_SESSION_ID: exec.agent.id, DSH_OPENCRAFT_THREAD_ID: port().resolve(exec.agent.id) }),
    },
    systemPrompt: { section() {} },
    tools: {
      register(value) {
        tool = value;
      },
    },
    jobs: {
      start(value) {
        const handle = value.run();
        jobs.push(handle);
        return `job-${jobs.length}`;
      },
    },
  };
  ctx.shell = Object.assign(Object.create(sdk.executor.LocalBashExecutor.prototype), {
    ctx,
    source: () => ({
      cwd: root,
      timeoutMs: 10000,
      maxTimeoutMs: 20000,
      maxOutputBytes: 65536,
      maxSpillBytes: 65536,
      graceMs: 100,
    }),
  });
  sdk.bash.apply(ctx);
  return {
    ctx,
    tool,
    jobs,
    async close() {
      await subprocess.disposeManagedProcesses();
    },
  };
}
