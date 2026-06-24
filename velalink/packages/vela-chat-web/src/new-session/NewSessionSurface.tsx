import type { BackendKindWire, PermissionModeWire } from "../../../vela-chat-client/src";
import styles from "../styles/desktop.module.css";
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

  return (
    <main className={styles.newSessionShell} aria-label="New session">
      <form
        className={styles.newSessionContent}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || !selectedBackend) return;
          onSubmit({
            backend: selectedBackend,
            workingDirectory: workingDirectory.trim(),
            initialPrompt: initialPrompt.trim(),
            agentConfig,
          });
        }}
      >
        <section className={styles.newSessionHeader}>
          <h1>New session</h1>
          <p>Choose the runtime setup before opening a chat.</p>
        </section>

        <section className={styles.newSessionDirectory} aria-label="Workspace">
          <label htmlFor="new-session-working-directory">Workspace</label>
          <input
            id="new-session-working-directory"
            value={workingDirectory}
            onChange={(event) => onWorkingDirectoryChange(event.currentTarget.value)}
            placeholder="Enter a project path"
            spellCheck={false}
          />
        </section>

        <section className={styles.newSessionComposer} aria-label="Initial prompt">
          <textarea
            value={initialPrompt}
            onChange={(event) => onInitialPromptChange(event.currentTarget.value)}
            placeholder="Ask Codex to inspect, edit, or explain this workspace"
            rows={4}
          />
          <div className={styles.newSessionControls}>
            <div className={styles.newSessionSelectGroup}>
              <SelectControl
                label="Backend"
                value={selectedBackend}
                options={backendOptions}
                placeholder="No backend"
                onChange={(value) => onBackendChange(value as BackendKindWire | "")}
              />
              <SelectControl
                label="Model"
                value={selectedModel}
                options={modelOptions}
                placeholder="Default model"
                onChange={onModelChange}
              />
              <SelectControl
                label="Reasoning"
                value={selectedReasoningEffort}
                options={reasoningEffortOptions}
                placeholder="Default reasoning"
                onChange={onReasoningEffortChange}
              />
              <SelectControl
                label="Permissions"
                value={selectedPermissionMode}
                options={permissionModeOptions}
                placeholder="Default permissions"
                onChange={(value) => onPermissionModeChange(value as PermissionModeWire | "")}
              />
            </div>

            <button
              className={styles.newSessionSubmit}
              type="submit"
              disabled={!canSubmit}
            >
              {isSubmitting ? "Creating" : "Create session"}
            </button>
          </div>
        </section>

        {surfaceError ? <div className={styles.newSessionError}>{surfaceError}</div> : null}
      </form>
    </main>
  );
}

function SelectControl<T extends string>({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: T | "";
  options: NewSessionOption<T>[];
  placeholder: string;
  onChange: (value: T | "") => void;
}) {
  return (
    <label className={styles.newSessionSelect}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as T | "")}
        disabled={options.length === 0}
      >
        {options.length === 0 || !value ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option value={option.id} disabled={option.disabled} key={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
