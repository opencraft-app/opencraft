import type { SDKMessage, RunResult } from "@cursor/sdk";
export interface CursorRun {
  id: string;
  steer?: (text: string) => Promise<"complete_delivered" | "revert_to_followup">;
  stream(): AsyncIterable<SDKMessage>;
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
}
export interface CursorAgent {
  agentId: string;
  send(text: string): Promise<CursorRun>;
  close(): Promise<void>;
}
export interface CursorFactory {
  hasCredentials(): Promise<boolean>;
  models(): Promise<readonly { id: string; name: string }[]>;
  create(cwd: string, model: string, stateDirectory: string): Promise<CursorAgent>;
}
