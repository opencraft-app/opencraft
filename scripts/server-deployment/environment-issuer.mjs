import { setTimeout as delay } from "node:timers/promises";
import {
  pinEnvironmentIssuerFromPublication,
  readPublishedEnvironmentIssuer,
  resolveEnvironmentIssuer,
  unissuableEnvironmentIssuer,
} from "@opencraft/execution-environment/environment-issuer-publication";

// Pinning the vault owner's ENV issuer into independent execution owners. The
// publication rules live with the vault owner's package so Codex Core applies
// exactly the same ones; this module adds the deployment supervisors' side.
export { readPublishedEnvironmentIssuer, resolveEnvironmentIssuer, unissuableEnvironmentIssuer };

/** Launch-time pinning for an execution owner whose trusted configuration
 * names the publication (`environmentIssuerFile`) instead of a key, as under
 * systemd where the unit restarts when the publication changes. */
export function pinPublishedEnvironmentIssuer(configuration, log = (message) => console.error(message)) {
  return pinEnvironmentIssuerFromPublication(
    configuration,
    { file: "environmentIssuerFile", key: "environmentIssuer" },
    log,
  );
}

/** Supervisor loop: whenever a valid published key differs from the pinned
 * one, `replace(issuer)` must reconfigure and relaunch the execution owners.
 * An unreadable or refused publication keeps the current pin (fail closed). */
export async function watchEnvironmentIssuer({
  path,
  pinned,
  signal,
  replace,
  interval = 2000,
  read = readPublishedEnvironmentIssuer,
  log = (message) => console.error(message),
}) {
  let current = pinned,
    refused = false;
  while (!signal.aborted) {
    try {
      await delay(interval, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    let published;
    try {
      published = await read(path);
      refused = false;
    } catch {
      if (!refused) log(JSON.stringify({ type: "environment-issuer-unavailable", reason: "refused" }));
      refused = true;
      continue;
    }
    if (published === null || published === current || signal.aborted) continue;
    await replace(published);
    current = published;
  }
}
