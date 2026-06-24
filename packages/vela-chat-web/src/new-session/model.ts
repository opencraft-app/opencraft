import type { AgentConfigWire, BackendKindWire, PermissionModeWire } from "../../../vela-chat-client/src";

export interface NewSessionOption<T extends string = string> {
  id: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface NewSessionFormState {
  backend: BackendKindWire | "";
  model: string;
  reasoningEffort: string;
  permissionMode: PermissionModeWire | "";
  workingDirectory: string;
  initialPrompt: string;
}

export interface NewSessionSubmitInput {
  backend: BackendKindWire;
  workingDirectory: string;
  initialPrompt: string;
  agentConfig: AgentConfigWire;
}

export function canSubmitNewSession(input: {
  backend: BackendKindWire | "";
  workingDirectory: string;
  isSubmitting?: boolean;
}) {
  return Boolean(input.backend && input.workingDirectory.trim() && !input.isSubmitting);
}

export function buildNewSessionTitle(initialPrompt: string) {
  const text = initialPrompt.trim().replace(/\s+/g, " ");
  if (!text) return "New chat";
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}
