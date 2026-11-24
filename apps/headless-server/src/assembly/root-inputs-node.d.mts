import type { AssertionProviderOptions } from "@opencraft/identity-core/node";
import type { InstallationRootInputs } from "./root-inputs.ts";

export function nodeRootInputs(options: {
  dataDirectory: string;
  machineName?: string;
  /** Path of the private Human login configuration file. */
  humanAuthConfig?: string;
  /** Path of the private relay connection file. */
  relayConnectFile?: string;
  relayAssertionOptions?: AssertionProviderOptions;
}): InstallationRootInputs;
