// Isolated drill Core: the product Core program with only its upstream moved to
// the drill's local model server. Arguments are the product Core's.
import { readFileSync } from "node:fs";
import { startCodexCore } from "../../apps/codex-core/src/main.js";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const upstream = process.env.OPENCRAFT_DRILL_UPSTREAM;
if (!upstream || new URL(upstream).hostname !== "127.0.0.1") throw new Error("Drill Core requires a loopback upstream");
void (async () => {
let shutdown: ((code: number) => Promise<void>) | undefined;
const core = await startCodexCore({
  endpoint: argument("--endpoint")!, appServerEndpoint: argument("--app-server-endpoint"),
  proxyPort: Number(argument("--proxy-port")),
  authToken: readFileSync(argument("--token-file")!, "utf8").trim(),
  executable: argument("--codex-executable")!, runtimeDirectory: argument("--runtime-directory")!,
  dataDirectory: argument("--data-directory")!, nativeCodexHomeDirectory: argument("--native-codex-home-directory")!,
  upstreamBaseUrl: upstream,
  fetch: (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const target = raw.includes("/wham/usage") ? `${upstream}/usage` : raw;
    if (new URL(target).hostname !== "127.0.0.1") throw new Error("Non-local request in isolated drill");
    return fetch(target, init);
  },
  onFailure: error => { console.error(error.message); void shutdown?.(1); },
});
shutdown = async code => { await core.close(); process.exit(code); };
process.once("SIGTERM", () => void shutdown!(0));
process.once("SIGINT", () => void shutdown!(0));
process.stdout.write(`${JSON.stringify({ type: "codex-accounts-listening", ...core.health })}\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
