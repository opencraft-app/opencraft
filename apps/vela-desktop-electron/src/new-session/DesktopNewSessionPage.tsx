import React, { useEffect, useMemo, useState } from "react";
import type {
  AgentConfigWire,
  BackendKindWire,
  BackendUsageWireResponse,
  BackendWire,
  PermissionModeWire,
  VeladClient,
} from "../../../../packages/vela-chat-client/src";
import { buildVelaSessionSetupSelection } from "../../../../packages/vela-chat-controller/src";
import type { VoiceInputHost } from "../../../../packages/vela-desktop-shell/src";
import {
  buildNewSessionTitle,
  NewSessionSurface,
  toComposerSkills,
  type ComposerSkill,
  type NewSessionOption,
  type NewSessionSubmitInput,
} from "../../../../packages/vela-chat-web/src";

export interface DesktopNewSessionSubmitInput {
  backend: BackendKindWire;
  workingDirectory: string;
  initialPrompt: string;
  initialSkillRefs?: NewSessionSubmitInput["initialSkillRefs"];
  title: string;
  agentConfig: AgentConfigWire;
}

export interface DesktopNewSessionPageProps {
  backends: BackendWire[];
  backendUsages?: Partial<Record<BackendKindWire, BackendUsageWireResponse>>;
  defaultBackend: BackendKindWire | "";
  defaultWorkingDirectory: string;
  error?: string | null;
  isSubmitting?: boolean;
  client: VeladClient;
  preferredBackends: BackendKindWire[];
  runtimeHostKind?: "electron" | "web";
  voiceInput?: VoiceInputHost;
  onDefaultBackendChange: (backend: BackendKindWire | "") => void;
  onSelectWorkingDirectory?: () => Promise<string | null> | string | null;
  onSubmit: (input: DesktopNewSessionSubmitInput) => Promise<void> | void;
}

const LOCAL_ENVIRONMENT_ID = "local";
const ENVIRONMENT_OPTIONS: NewSessionOption[] = [{ id: LOCAL_ENVIRONMENT_ID, label: "Local" }];

export function DesktopNewSessionPage({
  backends,
  backendUsages = {},
  defaultBackend,
  defaultWorkingDirectory,
  error,
  isSubmitting,
  client,
  preferredBackends,
  runtimeHostKind = "web",
  voiceInput,
  onDefaultBackendChange,
  onSelectWorkingDirectory,
  onSubmit,
}: DesktopNewSessionPageProps) {
  const [selectedEnvironment, setSelectedEnvironment] = useState(LOCAL_ENVIRONMENT_ID);
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
  const [skills, setSkills] = useState<ComposerSkill[]>([]);

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
  const surfaceBackendDetails =
    backends.find((backend) => backend.kind === surfaceBackend) ?? null;
  const backendStatus = backendStatusMessage(
    surfaceBackendDetails ??
      backends.find((backend) => backend.status !== "available") ??
      null,
    Boolean(setup.resolvedSelectedBackend),
  );
  const canSelectWorkingDirectory =
    selectedEnvironment === LOCAL_ENVIRONMENT_ID &&
    canUseNativeWorkingDirectoryPicker(runtimeHostKind, surfaceBackendDetails);

  useEffect(() => {
    let disposed = false;
    if (!surfaceBackend || !workingDirectory.trim()) {
      setSkills([]);
      return;
    }
    void client
      .listBackendSkills(surfaceBackend, { cwd: workingDirectory.trim() })
      .then((response) => {
        if (!disposed) setSkills(toComposerSkills(response.skills));
      })
      .catch(() => {
        if (!disposed) setSkills([]);
      });
    return () => {
      disposed = true;
    };
  }, [client, surfaceBackend, workingDirectory]);

  return (
    <NewSessionSurface
      agentConfig={setup.setupAgentConfig}
      backendOptions={backendOptions(backends, backendUsages)}
      backendStatusMessage={backendStatus}
      environmentOptions={ENVIRONMENT_OPTIONS}
      error={error}
      initialPrompt={initialPrompt}
      isSubmitting={isSubmitting}
      modelOptions={optionList(setup.setupModelOptions)}
      permissionModeOptions={optionList(setup.setupPermissionOptions)}
      reasoningEffortOptions={optionList(setup.setupReasoningOptions)}
      selectedBackend={surfaceBackend}
      selectedEnvironment={selectedEnvironment}
      selectedModel={setup.setupSelectedModel}
      selectedPermissionMode={setup.setupSelectedPermissionMode}
      selectedReasoningEffort={setup.setupSelectedReasoningEffort}
      skills={skills}
      voiceInput={voiceInput}
      workingDirectory={workingDirectory}
      onBackendChange={(backend) => {
        setSelectedBackend(backend);
        setSelectedModel("");
        setSelectedReasoningEffort("");
        setSelectedPermissionMode("");
        onDefaultBackendChange(backend);
      }}
      onEnvironmentChange={setSelectedEnvironment}
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
      onSelectWorkingDirectory={canSelectWorkingDirectory ? onSelectWorkingDirectory : undefined}
      onWorkingDirectoryChange={setWorkingDirectory}
    />
  );
}

export function canUseNativeWorkingDirectoryPicker(
  runtimeHostKind: "electron" | "web",
  backend: BackendWire | null | undefined,
) {
  return runtimeHostKind === "electron" && backend?.location.kind === "local";
}

async function submitNewSession(
  input: NewSessionSubmitInput,
  onSubmit: DesktopNewSessionPageProps["onSubmit"],
) {
  await onSubmit({
    backend: input.backend,
    workingDirectory: input.workingDirectory,
    initialPrompt: input.initialPrompt,
    initialSkillRefs: input.initialSkillRefs,
    title: buildNewSessionTitle(input.initialPrompt),
    agentConfig: input.agentConfig,
  });
}

function backendOptions(
  backends: BackendWire[],
  backendUsages: Partial<Record<BackendKindWire, BackendUsageWireResponse>>,
): NewSessionOption<BackendKindWire>[] {
  return backends.map((backend) => ({
    id: backend.kind,
    label:
      backend.status === "available"
        ? backend.display_name
        : `${backend.display_name} (${backend.status})`,
    disabled: !isBackendSelectable(backend),
    description: backendOptionDescription(backend, backendUsages[backend.kind]),
  }));
}

function backendOptionDescription(
  backend: BackendWire,
  usage: BackendUsageWireResponse | undefined,
) {
  const usageLabel = usage?.summary?.label;
  if (backend.status_message && usageLabel) return `${backend.status_message} · ${usageLabel}`;
  return usageLabel ?? backend.status_message;
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
