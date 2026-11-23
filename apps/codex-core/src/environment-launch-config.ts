import { readFile } from "node:fs/promises";
import { pinEnvironmentIssuerFromPublication } from "@opencraft/execution-environment/environment-issuer-publication";
import type { CodexAppServerOptions } from "./app-server.js";

/** Read `--environment-launch-config`: a trusted private file with the pinned
 * issuer key, this owner's attachment and where it reads its own durable
 * admission. Instead of `issuer` it may name the vault owner's publication
 * (`environmentIssuerFile`, as under systemd), read once at launch with the
 * publication rules; a missing or refused publication pins an unissuable key,
 * so every Human delivery fails closed. A request or the Gateway never
 * supplies the key. Validation of the result stays in `startCodexAppServer`. */
export async function readEnvironmentLaunchConfiguration(
  path: string,
  log?: (message: string) => void,
): Promise<CodexAppServerOptions["environmentLaunch"]> {
  const configuration: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
    throw new Error("Invalid execution environment delivery configuration");
  return (await pinEnvironmentIssuerFromPublication(
    configuration,
    { file: "environmentIssuerFile", key: "issuer" },
    log,
  )) as CodexAppServerOptions["environmentLaunch"];
}
