import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createHeadlessAssetsStorage } from "../../apps/headless-server/src/assets-runtime-storage.js";
import {
  environmentLoginPartition,
  type EnvironmentAccountMapping,
} from "@opencraft/execution-environment/environment-account";

/** Synthetic installation policies compiled into this Worker entry. The test
 * selects one before the Worker starts; no request or Worker data chooses it. */
const policies: Record<string, EnvironmentAccountMapping> = {
  // Values live under the login partition of the Actor's directory binding.
  directory: (owner) => {
    const logins = owner.bindings.filter((b) => b.provider === "directory");
    return logins.length === 1 ? environmentLoginPartition(logins[0]!) : null;
  },
  // A partition no verified binding of this Actor names.
  foreign: () => "directory:someone-else",
  // Picks the first of several directory logins instead of refusing.
  first: (owner) => {
    const login = owner.bindings.find((b) => b.provider === "directory");
    return login ? environmentLoginPartition(login) : null;
  },
};
const policy = policies[process.env.OPENCRAFT_TEST_ENVIRONMENT_ACCOUNT ?? ""];
if (!policy) throw Error("Synthetic account policy required");
serveWorkerOwner<{ directory: string; environmentLaunch?: boolean }>(({ directory, environmentLaunch }) =>
  createHeadlessAssetsStorage(directory, [], undefined, {
    environmentLaunch: environmentLaunch === true,
    environmentAccount: policy,
  }),
);
