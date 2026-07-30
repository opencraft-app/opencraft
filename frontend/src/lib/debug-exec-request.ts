import { isGlobal } from "@/lib/region";

export interface DebugExecRequestBody {
  command: string;
  run_as_user: "agentuser";
  execution_backend?: "tat";
}

export function createDebugExecRequestBody(command: string): DebugExecRequestBody {
  return {
    command,
    run_as_user: "agentuser",
    ...(isGlobal ? { execution_backend: "tat" as const } : {}),
  };
}
