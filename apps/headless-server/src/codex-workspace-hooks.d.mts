import type { CodexEngineAdapter } from '../../opencraft-daemon/src/codex-engine-adapter.js';
type LocalOptions = Exclude<ConstructorParameters<typeof CodexEngineAdapter>[0], {kind: 'remote'}>;
export type CodexWorkspaceHooks = Pick<LocalOptions, 'decorateNativeTransport' | 'finalizeNativeCreation'
  | 'readWorkspaceArtifact' | 'prepareWorkspaceArtifact' | 'finalizeNativeResume' | 'requiresWorkspaceResume' | 'restoreProvisionalWorkspace'>;
export interface CodexWorkspaceComposition {
  createCodexWorkspaceHooks?(input: Readonly<{hostId: string}>): CodexWorkspaceHooks;
  readCodexWorkspaceArtifact?: CodexWorkspaceHooks['readWorkspaceArtifact'];
  prepareCodexWorkspaceArtifact?: CodexWorkspaceHooks['prepareWorkspaceArtifact'];
  decorateCodexNativeTransport?: CodexWorkspaceHooks['decorateNativeTransport'];
  finalizeCodexNativeCreation?: CodexWorkspaceHooks['finalizeNativeCreation'];
  finalizeCodexNativeResume?: CodexWorkspaceHooks['finalizeNativeResume'];
  requiresCodexWorkspaceResume?: CodexWorkspaceHooks['requiresWorkspaceResume'];
  restoreCodexProvisionalWorkspace?: CodexWorkspaceHooks['restoreProvisionalWorkspace'];
}
export function hasCodexWorkspaceHooks(composition: CodexWorkspaceComposition): boolean;
export function validateCodexWorkspaceHooks(composition: CodexWorkspaceComposition): void;
export function createCodexWorkspaceHooks(composition: CodexWorkspaceComposition, hostId: string): Readonly<CodexWorkspaceHooks>;

export interface WorkspaceLifecycleRouting {
  releaseConversation(row: {hostId: string; threadId: string; generation: number;
    state: 'active' | 'archived' | 'deleted'}): Promise<void>;
  conversationScopes(): {hostId: string; threadId: string}[];
}
export function workspaceLifecycleRouting<T extends object>(owned: T | undefined,
  identity: (Partial<WorkspaceLifecycleRouting> & object) | undefined): (T | WorkspaceLifecycleRouting) | undefined;

export function configuredWorkspaceExecution(options: {codexCoreEndpoint?: string; codexCoreAuthToken?: string},
  environment?: Record<string, string | undefined>): Readonly<{socketPath: string; token: string}> | undefined;
