import type { AccountInputs } from "./account.mjs";

export function nodeAccountInputs(options: {
  dataDirectory: string;
  codexCoreEndpoint?: string;
  codexCoreAuthToken?: string;
}): AccountInputs & {
  /** The policy file engines and Hosts on this machine read directly. */
  readonly modelPolicyPath: string;
};
