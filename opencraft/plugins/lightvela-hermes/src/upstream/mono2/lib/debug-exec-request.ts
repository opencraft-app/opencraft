// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { isGlobal } from "./region";

export interface DebugExecRequestBody {
  command: string;
  run_as_user: "agentuser";
  execution_backend?: "tat";
}

export function createDebugExecRequestBody(command: string): DebugExecRequestBody {
  const body: DebugExecRequestBody = {
    command,
    run_as_user: "agentuser",
  };
  if (isGlobal) body.execution_backend = "tat";
  return body;
}
