export interface DebugExecRequestBody {
  command: string;
  run_as_user: "agentuser";
}

export function createDebugExecRequestBody(command: string): DebugExecRequestBody {
  return {
    command,
    run_as_user: "agentuser",
  };
}
