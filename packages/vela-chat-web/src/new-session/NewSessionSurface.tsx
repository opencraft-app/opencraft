import type { BackendKindWire, PermissionModeWire } from "../../../vela-chat-client/src";
import { ShellSelect } from "../../../vela-desktop-shell/src";
import { Brain, FolderGit2, Laptop, Shield } from "lucide-react";
import type { ReactNode } from "react";
import styles from "../styles/desktop.module.css";
import { PromptInput } from "../primitives/prompt-input/PromptInput";
import {
  canSubmitNewSession,
  type NewSessionOption,
  type NewSessionSubmitInput,
} from "./model";

export interface NewSessionSurfaceProps {
  backendOptions: NewSessionOption<BackendKindWire>[];
  modelOptions: NewSessionOption[];
  reasoningEffortOptions: NewSessionOption[];
  permissionModeOptions: NewSessionOption<PermissionModeWire>[];
  selectedBackend: BackendKindWire | "";
  selectedModel: string;
  selectedReasoningEffort: string;
  selectedPermissionMode: PermissionModeWire | "";
  workingDirectory: string;
  initialPrompt: string;
  agentConfig: NewSessionSubmitInput["agentConfig"];
  error?: string | null;
  backendStatusMessage?: string | null;
  isSubmitting?: boolean;
  onBackendChange: (backend: BackendKindWire | "") => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (reasoningEffort: string) => void;
  onPermissionModeChange: (permissionMode: PermissionModeWire | "") => void;
  onWorkingDirectoryChange: (workingDirectory: string) => void;
  onInitialPromptChange: (initialPrompt: string) => void;
  onSubmit: (input: NewSessionSubmitInput) => void;
}

export function NewSessionSurface({
  backendOptions,
  modelOptions,
  reasoningEffortOptions,
  permissionModeOptions,
  selectedBackend,
  selectedModel,
  selectedReasoningEffort,
  selectedPermissionMode,
  workingDirectory,
  initialPrompt,
  agentConfig,
  error,
  backendStatusMessage,
  isSubmitting,
  onBackendChange,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onWorkingDirectoryChange,
  onInitialPromptChange,
  onSubmit,
}: NewSessionSurfaceProps) {
  const canSubmit = canSubmitNewSession({
    backend: selectedBackend,
    workingDirectory,
    isSubmitting,
  });
  const surfaceError = error ?? backendStatusMessage;
  const permissionTone = selectedPermissionMode === "full_access" ? "accent" : "neutral";
  const submitSession = () => {
    if (!canSubmit || !selectedBackend) return;
    onSubmit({
      backend: selectedBackend,
      workingDirectory: workingDirectory.trim(),
      initialPrompt: initialPrompt.trim(),
      agentConfig,
    });
  };

  return (
    <main className={styles.newSessionShell} aria-label="New session">
      <div className={styles.newSessionContent}>
        <section className={styles.newSessionFrame} aria-label="New session composer">
          <PromptInput
            attachedSurface={
              <div className={styles.newSessionContextBar} aria-label="Session context">
                <label className={styles.newSessionWorkspaceField}>
                  <FolderGit2 size={17} aria-hidden />
                  <input
                    id="new-session-working-directory"
                    aria-label="Workspace path"
                    value={workingDirectory}
                    onChange={(event) => onWorkingDirectoryChange(event.currentTarget.value)}
                    placeholder="Workspace path"
                    spellCheck={false}
                  />
                </label>
                <SelectControl
                  ariaLabel="Select agent backend"
                  icon={<Laptop size={17} />}
                  value={selectedBackend}
                  options={backendOptions}
                  placeholder="No backend"
                  onChange={(value) => onBackendChange(value as BackendKindWire | "")}
                />
              </div>
            }
            canSubmit={canSubmit}
            isRunning={false}
            layout="inline"
            onChange={onInitialPromptChange}
            onSubmit={submitSession}
            placeholder="随心输入"
            submitLabel={isSubmitting ? "Creating session" : "Create session"}
            value={initialPrompt}
            leftToolbarControls={
              <div className={styles.newSessionControlCluster}>
                <SelectControl
                  ariaLabel="Select permission mode"
                  icon={<Shield size={16} />}
                  value={selectedPermissionMode}
                  options={permissionModeOptions}
                  placeholder="Permissions"
                  tone={permissionTone}
                  onChange={(value) => onPermissionModeChange(value as PermissionModeWire | "")}
                />
              </div>
            }
            rightToolbarControls={
              <div className={styles.newSessionControlCluster}>
                <SelectControl
                  ariaLabel="Select model"
                  icon={<Brain size={16} />}
                  value={selectedModel}
                  options={modelOptions}
                  placeholder="Default model"
                  onChange={onModelChange}
                />
                <SelectControl
                  ariaLabel="Select reasoning effort"
                  icon={null}
                  value={selectedReasoningEffort}
                  options={reasoningEffortOptions}
                  placeholder="Reasoning"
                  onChange={onReasoningEffortChange}
                />
              </div>
            }
          />
        </section>

        {surfaceError ? <div className={styles.newSessionError}>{surfaceError}</div> : null}
      </div>
    </main>
  );
}

function SelectControl<T extends string>({
  ariaLabel,
  icon,
  value,
  options,
  placeholder,
  tone = "neutral",
  onChange,
}: {
  ariaLabel: string;
  icon: ReactNode;
  value: T | "";
  options: NewSessionOption<T>[];
  placeholder: string;
  tone?: "neutral" | "accent";
  onChange: (value: T | "") => void;
}) {
  return (
    <ShellSelect
      ariaLabel={ariaLabel}
      density="compact"
      disabled={options.length === 0}
      leading={icon}
      options={options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        disabled: option.disabled,
      }))}
      placement="top-start"
      placeholder={placeholder}
      tone={tone}
      value={value || undefined}
      onValueChange={(nextValue) => onChange(nextValue as T)}
    />
  );
}
