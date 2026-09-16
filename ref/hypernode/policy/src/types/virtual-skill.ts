import type { AppServerConnection } from "./appserver.ts";
import type { McpAppLaunchRequest } from "./mcp.ts";

export interface VirtualSkillInvocation {
  connection: AppServerConnection;
  threadId: string;
  turnId: string | null;
}

export interface VirtualSkillInputItem extends Record<string, unknown> {
  type?: string;
  text?: string;
  name?: string;
  path?: string;
}

export type VirtualSkillResult = string | McpAppLaunchRequest;

export interface VirtualSkillRegistration {
  name: string;
  execution?: "synthetic" | "agent";
  aliases?: string[];
  description: string;
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
  instructions?: string;
  resources?: Record<string, string>;
  visible?(connection: AppServerConnection): boolean;
  run(
    input: VirtualSkillInputItem[],
    invocation: VirtualSkillInvocation,
  ): VirtualSkillResult;
}

export interface VirtualSkillPort {
  register(skill: VirtualSkillRegistration): () => boolean;
  replace(skill: VirtualSkillRegistration): () => boolean;
  remove(name: string): boolean;
  resolveInput(input: VirtualSkillInputItem[]): string | null;
  executeInput(
    input: VirtualSkillInputItem[],
    invocation: VirtualSkillInvocation,
  ): VirtualSkillResult;
}
