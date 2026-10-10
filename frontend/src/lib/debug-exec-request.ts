import { isGlobal } from "@/lib/region";

export interface DebugExecRequestBody {
  command: string;
  run_as_user: "agentuser";
  execution_backend?: "tat";
}

export function createDebugExecRequestBody(command: string, _target?: unknown): DebugExecRequestBody {
  const body: DebugExecRequestBody = {
    command,
    run_as_user: "agentuser",
  };
  if (isGlobal) body.execution_backend = "tat";
  return body;
}
