import type {
  AgentConfigPatchWire,
  BackendKindWire,
  PermissionModeWire,
} from "../../../vela-chat-client/src";
import { ShellSelect, type VoiceInputHost } from "../../../vela-desktop-shell/src";
import { FolderGit2, HardDrive, Laptop } from "lucide-react";
import { useState, type ReactNode } from "react";
import styles from "../styles/desktop.module.css";
import type { ComposerSkill } from "../composer-skills/model";
import { skillRefInputPartsFromText } from "../composer-skills/model";
import { PromptInput } from "../primitives/prompt-input/PromptInput";
import { ComposerControls } from "../components/composer-controls/ComposerControls";
import { buildComposerSetupControlsModel } from "../components/composer-controls/model";
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
  environmentOptions?: NewSessionOption[];
  selectedEnvironment?: string;
  selectedBackend: BackendKindWire | "";
  selectedModel: string;
  selectedReasoningEffort: string;
  selectedPermissionMode: PermissionModeWire | "";
  workingDirectory: string;
  initialPrompt: string;
  agentConfig: NewSessionSubmitInput["agentConfig"];
  skills?: ComposerSkill[];
  error?: string | null;
  backendStatusLoading?: boolean;
  backendStatusMessage?: string | null;
  isSubmitting?: boolean;
  voiceInput?: VoiceInputHost;
  onBackendChange: (backend: BackendKindWire | "") => void;
  onEnvironmentChange?: (environment: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (reasoningEffort: string) => void;
  onPermissionModeChange: (permissionMode: PermissionModeWire | "") => void;
  onWorkingDirectoryChange: (workingDirectory: string) => void;
  onSelectWorkingDirectory?: () => Promise<string | null> | string | null;
  onInitialPromptChange: (initialPrompt: string) => void;
  onSubmit: (input: NewSessionSubmitInput) => void;
}

export function NewSessionSurface({
  backendOptions,
  modelOptions,
  reasoningEffortOptions,
  permissionModeOptions,
  environmentOptions = [],
  selectedEnvironment = "",
  selectedBackend,
  selectedModel,
  selectedReasoningEffort,
  selectedPermissionMode,
  workingDirectory,
  initialPrompt,
  agentConfig,
  skills = [],
  error,
  backendStatusLoading = false,
  backendStatusMessage,
  isSubmitting,
  voiceInput,
  onBackendChange,
  onEnvironmentChange,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onWorkingDirectoryChange,
  onInitialPromptChange,
  onSubmit,
  onSelectWorkingDirectory,
}: NewSessionSurfaceProps) {
  const [workingDirectorySelectionError, setWorkingDirectorySelectionError] = useState<string | null>(
    null,
  );
  const canSubmit = canSubmitNewSession({
    backend: selectedBackend,
    workingDirectory,
    isSubmitting,
  });
  const surfaceError = error ?? workingDirectorySelectionError ?? backendStatusMessage;
  const selectedBackendLabel =
    backendOptions.find((option) => option.id === selectedBackend)?.label ?? "Agent";
  const composerControls = buildComposerSetupControlsModel({
    disabled: Boolean(isSubmitting),
    providerLabel: selectedBackendLabel,
    selectedModel,
    selectedReasoningEffort,
    selectedPermissionMode,
    modelOptions,
    reasoningEffortOptions,
    permissionModeOptions,
  });
  const applyAgentConfigPatch = (patch: AgentConfigPatchWire) => {
    if (typeof patch.model === "string") onModelChange(patch.model);
    if (typeof patch.reasoning_effort === "string") {
      onReasoningEffortChange(patch.reasoning_effort);
    }
    if (patch.permission_mode) onPermissionModeChange(patch.permission_mode);
  };
  const submitSession = (prompt = initialPrompt) => {
    if (!canSubmit || !selectedBackend) return;
    const trimmedPrompt = prompt.trim();
    onSubmit({
      backend: selectedBackend,
      workingDirectory: workingDirectory.trim(),
      initialPrompt: trimmedPrompt,
      initialSkillRefs: skillRefInputPartsFromText(trimmedPrompt, skills, selectedBackend),
      agentConfig,
    });
  };
  const selectWorkingDirectory = async () => {
    if (!onSelectWorkingDirectory) return;
    setWorkingDirectorySelectionError(null);
    try {
      const nextWorkingDirectory = await onSelectWorkingDirectory();
      if (typeof nextWorkingDirectory === "string" && nextWorkingDirectory.trim()) {
        onWorkingDirectoryChange(nextWorkingDirectory);
      }
    } catch (err) {
      setWorkingDirectorySelectionError(
        err instanceof Error ? err.message : "Failed to select workspace folder.",
      );
    }
  };

  return (
    <main className={styles.newSessionShell} aria-label="New session">
      <div className={styles.newSessionContent}>
        <section className={styles.newSessionFrame} aria-label="New session composer">
          <PromptInput
            attachedSurface={
              <div className={styles.newSessionContextBar} aria-label="Session context">
                {environmentOptions.length ? (
                  <SelectControl
                    ariaLabel="Select runtime environment"
                    icon={<HardDrive size={17} />}
                    value={selectedEnvironment}
                    options={environmentOptions}
                    placeholder="Environment"
                    onChange={(value) => onEnvironmentChange?.(value)}
                  />
                ) : null}
                <div className={styles.newSessionWorkspaceField}>
                  {onSelectWorkingDirectory ? (
                    <button
                      type="button"
                      className={styles.newSessionWorkspacePicker}
                      aria-label="Choose workspace folder"
                      onClick={() => {
                        void selectWorkingDirectory();
                      }}
                    >
                      <FolderGit2 size={17} aria-hidden />
                    </button>
                  ) : (
                    <FolderGit2 size={17} aria-hidden />
                  )}
                  <input
                    id="new-session-working-directory"
                    aria-label="Workspace path"
                    value={workingDirectory}
                    onChange={(event) => onWorkingDirectoryChange(event.currentTarget.value)}
                    placeholder="Workspace path"
                    spellCheck={false}
                  />
                </div>
                <SelectControl
                  ariaLabel="Select agent backend"
                  icon={<Laptop size={17} />}
                  value={selectedBackend}
                  options={backendOptions}
                  placeholder="No backend"
                  onChange={(value) => onBackendChange(value as BackendKindWire | "")}
                />
                {backendStatusLoading ? (
                  <span
                    className={styles.newSessionBackendLoading}
                    aria-label="Backend catalog loading"
                    role="status"
                  >
                    <span className={styles.newSessionBackendSpinner} aria-hidden="true" />
                  </span>
                ) : null}
              </div>
            }
            canSubmit={canSubmit}
            canSubmitText={canSubmit}
            isRunning={false}
            layout="inline"
            onChange={onInitialPromptChange}
            onSubmit={submitSession}
            onSubmitText={submitSession}
            placeholder="随心输入"
            submitLabel={isSubmitting ? "Creating session" : "Create session"}
            value={initialPrompt}
            skills={skills}
            voiceInput={voiceInput}
            leftToolbarControls={
              <ComposerControls
                controls={composerControls}
                placement="primary"
                onChange={applyAgentConfigPatch}
              />
            }
            rightToolbarControls={
              <ComposerControls
                controls={composerControls}
                placement="secondary"
                onChange={applyAgentConfigPatch}
              />
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
