import type {
  LightVelaAccountService,
  LightVelaDebugCommandResult,
} from "../account/lightvela-account-service";

export interface HermesDebugCommandExecutor {
  execDebugCommand(
    botId: string,
    command: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<LightVelaDebugCommandResult>;
}

export function accountDebugCommandExecutor(account: LightVelaAccountService): HermesDebugCommandExecutor {
  return { execDebugCommand: account.execDebugCommand.bind(account) };
}

/** Copied from mono2 agent-reset-config.ts. */
export function isExecCommandSucceeded(result: { status: string; exitCode: number }): boolean {
  if (result.exitCode !== 0) return false;
  const upper = (result.status || "").trim().toUpperCase();
  return upper === "SUCCESS" || upper === "SUCCEEDED";
}

/** Copied from mono2 agent-reset-config.ts. */
export function truncateExecOutput(
  output: string | undefined,
  status: string,
  maxBytes = 1200,
): string {
  const trimmed = (output || "").trim();
  if (!trimmed) return status;
  if (trimmed.length <= maxBytes) return trimmed;
  return `…${trimmed.slice(-maxBytes)}`;
}
