// Isolated drill child entry. Configuration contains synthetic data only.
import { readFile } from "node:fs/promises";
import { startCodexCore } from "../../apps/codex-core/src/main.js";
import { startCodexAppServer } from "../../apps/codex-core/src/app-server.js";

const options = JSON.parse(await readFile(process.argv[3]!, "utf8"));
let shutdown: ((code: number) => Promise<void>) | undefined;
const onFailure = () => void shutdown?.(1);
const service = process.argv[2] === "runtime" ? await startCodexAppServer({ ...options, onFailure })
  : await startCodexCore({ ...options, onFailure, fetch: (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    // Both quota maintenance and inference stay on the local fixture server.
    const target = raw.includes("/wham/usage") ? `${options.upstreamBaseUrl}/usage` : raw;
    if (new URL(target).hostname !== "127.0.0.1") throw new Error("Non-local model request in isolated drill");
    return fetch(target, init);
  } });
shutdown = async code => { await service.close(); process.exit(code); };
process.on("SIGTERM", () => void shutdown!(0));
process.on("SIGINT", () => void shutdown!(0));
process.stdout.write("ready\n");
