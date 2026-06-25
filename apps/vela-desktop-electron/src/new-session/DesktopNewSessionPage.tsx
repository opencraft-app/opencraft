import React, { useEffect, useMemo, useState } from "react";
import type {
  AgentConfigWire,
  BackendKindWire,
  BackendWire,
  PermissionModeWire,
} from "../../../../packages/vela-chat-client/src";
import { buildVelaSessionSetupSelection } from "../../../../packages/vela-chat-controller/src";
import type { VoiceInputHost } from "../../../../packages/vela-desktop-shell/src";
import {
  buildNewSessionTitle,
  NewSessionSurface,
  type NewSessionOption,
  type NewSessionSubmitInput,
} from "../../../../packages/vela-chat-web/src";

export interface DesktopNewSessionSubmitInput {
  backend: BackendKindWire;
  workingDirectory: string;
  initialPrompt: string;
  title: string;
  agentConfig: AgentConfigWire;
}

export interface DesktopNewSessionPageProps {
  backends: BackendWire[];
  defaultBackend: BackendKindWire | "";
  defaultWorkingDirectory: string;
  error?: string | null;
  isSubmitting?: boolean;
  preferredBackends: BackendKindWire[];
  voiceInput?: VoiceInputHost;
  onDefaultBackendChange: (backend: BackendKindWire | "") => void;
  onSubmit: (input: DesktopNewSessionSubmitInput) => Promise<void> | void;
}

export function DesktopNewSessionPage({
  backends,
  defaultBackend,
  defaultWorkingDirectory,
  error,
  isSubmitting,
  preferredBackends,
  voiceInput,
  onDefaultBackendChange,
  onSubmit,
}: DesktopNewSessionPageProps) {
  const [selectedBackend, setSelectedBackend] = useState<BackendKindWire | "">(
    defaultBackend,
  );
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("");
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionModeWire | "">(
    "",
  );
  const [workingDirectory, setWorkingDirectory] = useState(defaultWorkingDirectory);
  const [initialPrompt, setInitialPrompt] = useState("");

  useEffect(() => {
    if (!selectedBackend && defaultBackend) {
      setSelectedBackend(defaultBackend);
    }
  }, [defaultBackend, selectedBackend]);

  const setup = useMemo(
    () =>
      buildVelaSessionSetupSelection({
        backends,
        selectedBackend: selectedBackend || defaultBackend,
        preferredBackends,
        selectedModel,
        selectedPermissionMode,
        selectedReasoningEffort,
      }),
    [
      backends,
      defaultBackend,
      preferredBackends,
      selectedBackend,
      selectedModel,
      selectedPermissionMode,
      selectedReasoningEffort,
    ],
  );
  const surfaceBackend = selectedBackend || setup.resolvedSelectedBackend;
  const backendStatus = backendStatusMessage(
    backends.find((backend) => backend.kind === surfaceBackend) ??
      backends.find((backend) => backend.status !== "available") ??
      null,
    Boolean(setup.resolvedSelectedBackend),
  );

  return (
    <NewSessionSurface
      agentConfig={setup.setupAgentConfig}
      backendOptions={backendOptions(backends)}
      backendStatusMessage={backendStatus}
      error={error}
      initialPrompt={initialPrompt}
      isSubmitting={isSubmitting}
      modelOptions={optionList(setup.setupModelOptions)}
      permissionModeOptions={optionList(setup.setupPermissionOptions)}
      reasoningEffortOptions={optionList(setup.setupReasoningOptions)}
      selectedBackend={surfaceBackend}
      selectedModel={setup.setupSelectedModel}
      selectedPermissionMode={setup.setupSelectedPermissionMode}
      selectedReasoningEffort={setup.setupSelectedReasoningEffort}
      voiceInput={voiceInput}
      workingDirectory={workingDirectory}
      onBackendChange={(backend) => {
        setSelectedBackend(backend);
        setSelectedModel("");
        setSelectedReasoningEffort("");
        setSelectedPermissionMode("");
        onDefaultBackendChange(backend);
      }}
      onInitialPromptChange={setInitialPrompt}
      onModelChange={(model) => {
        setSelectedModel(model);
        setSelectedReasoningEffort("");
      }}
      onPermissionModeChange={setSelectedPermissionMode}
      onReasoningEffortChange={setSelectedReasoningEffort}
      onSubmit={(input) => {
        void submitNewSession(input, onSubmit);
      }}
      onWorkingDirectoryChange={setWorkingDirectory}
    />
  );
}

async function submitNewSession(
  input: NewSessionSubmitInput,
  onSubmit: DesktopNewSessionPageProps["onSubmit"],
) {
  await onSubmit({
    backend: input.backend,
    workingDirectory: input.workingDirectory,
    initialPrompt: input.initialPrompt,
    title: buildNewSessionTitle(input.initialPrompt),
    agentConfig: input.agentConfig,
  });
}

function backendOptions(backends: BackendWire[]): NewSessionOption<BackendKindWire>[] {
  return backends.map((backend) => ({
    id: backend.kind,
    label:
      backend.status === "available"
        ? backend.display_name
        : `${backend.display_name} (${backend.status})`,
    disabled: !isBackendSelectable(backend),
    description: backend.status_message,
  }));
}

function isBackendSelectable(backend: BackendWire) {
  return backend.status === "available" || backend.status === "degraded";
}

function optionList<T extends string>(
  options: Array<{ id: T; label: string; description?: string }>,
) {
  return options.map((option) => ({
    id: option.id,
    label: option.label,
    description: option.description,
  }));
}

function backendStatusMessage(
  backend: BackendWire | null,
  hasAvailableBackend: boolean,
) {
  if (!backend) {
    return hasAvailableBackend ? null : "No backend is available yet.";
  }
  if (backend.status === "loading") {
    return `Backend ${backend.display_name || backend.kind} is loading.`;
  }
  if (backend.status === "available") return null;
  if (backend.status_message) return backend.status_message;
  const snapshotError = backend.diagnostics?.error;
  if (typeof snapshotError === "object" && snapshotError !== null && "message" in snapshotError) {
    const message = snapshotError.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return `Backend ${backend.display_name || backend.kind} is ${backend.status}.`;
}
