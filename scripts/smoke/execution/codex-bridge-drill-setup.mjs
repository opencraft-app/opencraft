// Shared setup for drills that run the daemon's Codex bridge stack against a
// local stand-in model: the pinned native Codex and a copy of the daemon's
// codex-bridge programs whose Core only talks to the loopback model
// (tests/fixtures/bridge-stack-core.ts reads OPENCRAFT_DRILL_UPSTREAM).
import { cp, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { codexExecutableName, stageCodexRuntime } from "../../packaging/stage-codex-runtime.mjs";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const daemonDist = join(repositoryRoot, "apps/opencraft-daemon/dist");

/** The native Codex under test: OPENCRAFT_CODEX_EXECUTABLE, or runtime/codex staged for this host. */
export async function drillCodexExecutable() {
  if (process.env.OPENCRAFT_CODEX_EXECUTABLE) return process.env.OPENCRAFT_CODEX_EXECUTABLE;
  const staged = await stageCodexRuntime({ platform: process.platform, arch: process.arch });
  console.log(`codex ${staged.version} (${staged.target})`);
  return join(staged.output, "bin", codexExecutableName(process.platform));
}

/** Copy the built codex-bridge programs to `directory`, with the drill Core in place of the product Core. */
export async function prepareDrillPrograms(directory) {
  try {
    await stat(join(daemonDist, "codex-bridge"));
  } catch {
    throw new Error("Build the daemon first: npm run build --workspace @opencraft/opencraft-daemon");
  }
  await cp(join(daemonDist, "codex-bridge"), directory, { recursive: true });
  await build({
    entryPoints: [join(repositoryRoot, "tests/fixtures/bridge-stack-core.ts")],
    bundle: true, platform: "node", target: "node24", external: ["node-pty"], logLevel: "warning",
    format: "cjs", outfile: join(directory, "codex-core.cjs"),
  });
  return directory;
}
