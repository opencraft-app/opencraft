import type {
  SandboxBackend,
  SandboxIdentity,
  SandboxResources,
} from "@opencraft/sandbox";
import type { AssistantEnvironmentProvider } from "./host-supervisor.mjs";
export interface AssistantSandboxTemplate {
  id: string;
  name: string;
  resources: SandboxResources;
  workspaceRoot: string;
  python?: string;
}
export function createSandboxAssistantProvider(options: {
  backendId: string;
  templates: readonly AssistantSandboxTemplate[];
  capacity: SandboxResources;
  maxCommandMs?: number;
  /** Dedicated remote workspace derived only from the authenticated Bot binding. */
  persistentWorkspaces?: boolean;
  onReconciliation?(identity: {
    backend: string;
    owner: string;
    id?: string;
  }): void;
  createBackend(
    template: AssistantSandboxTemplate,
    lease: {
      authorize(identity: SandboxIdentity): Promise<void>;
      workspaceId(identity: SandboxIdentity): Promise<string | undefined>;
      onLost(identity: SandboxIdentity): void;
    },
  ): SandboxBackend | Promise<SandboxBackend>;
  spawnLocal?: typeof import("./host-supervisor.mjs").spawnAssistant;
}): Promise<AssistantEnvironmentProvider & { close(): Promise<void> }>;
