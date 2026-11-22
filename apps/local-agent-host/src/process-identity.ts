import { validateEnvironmentName } from "@opencraft/execution-environment/account-environment";
import type { ExecutionEnvironmentRuntime, EnvironmentExecutionScope } from "@opencraft/execution-environment";

// Process identity the local Host prepares before handing a spawn to the
// terminal owner process; no PTY or process-table access.
export class TerminalCapacityError extends Error {
  constructor() {
    super("Terminal limit reached. Close an existing terminal before creating another.");
  }
}
export interface PreparedProcessIdentity {
  owner?: string;
  quotaOwner: string;
  scope?: EnvironmentExecutionScope;
  env?: Record<string, string>;
  /** Private owner IPC; never accepted from a public process request. */
  lifecycleAuthority?: boolean;
}

export function prepareProcessIdentity(
  environment: ExecutionEnvironmentRuntime | undefined,
  scope: EnvironmentExecutionScope | undefined,
  method: string,
  raw: unknown,
): PreparedProcessIdentity {
  if (environment && !scope) throw new Error("Environment execution identity required");
  const snapshot = scope && environment?.snapshot(scope);
  const identity: PreparedProcessIdentity = {
    owner: snapshot?.owner,
    quotaOwner: JSON.stringify([scope?.account ?? null, scope?.hostId ?? "local"]),
    scope,
  };
  if (method !== "process/spawn") return identity;
  const p = object(raw ?? {}),
    env: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot?.apply(process.env) ?? process.env))
    if (value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries(p.env == null ? {} : object(p.env))) {
    if (snapshot) validateEnvironmentName(key);
    if (snapshot && Object.hasOwn(snapshot.overlay(), key)) throw new Error("Managed environment cannot be overridden");
    if (value === null) delete env[key];
    else if (typeof value === "string") env[key] = value;
    else throw new Error("Invalid process environment");
  }
  env.TERM = "xterm-256color";
  identity.env = env;
  return identity;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected process parameters");
  return value as Record<string, unknown>;
}
