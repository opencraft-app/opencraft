import type {
  BackendModelWire,
  BackendWire,
  PermissionModeOptionWire,
  PermissionModeWire,
  ReasoningEffortOptionWire,
  SessionWire,
} from "../../../../vela-chat-client/src";

export interface ComposerControlsModel {
  ready: boolean;
  disabled: boolean;
  providerLabel: string;
  selectedModel?: ComposerModelOption;
  selectedReasoningEffort?: ComposerOption;
  selectedPermissionMode?: ComposerPermissionOption;
  modelOptions: ComposerModelOption[];
  reasoningEffortOptions: ComposerOption[];
  permissionModeOptions: ComposerPermissionOption[];
}

export interface ComposerOption {
  id: string;
  label: string;
  description?: string;
}

export interface ComposerModelOption extends ComposerOption {
  reasoningEfforts: ComposerOption[];
}

export interface ComposerPermissionOption extends ComposerOption {
  id: PermissionModeWire;
}

export interface ComposerSetupControlsInput {
  disabled?: boolean;
  providerLabel: string;
  selectedModel: string;
  selectedReasoningEffort: string;
  selectedPermissionMode: PermissionModeWire | "";
  modelOptions: Array<ComposerOption>;
  reasoningEffortOptions: Array<ComposerOption>;
  permissionModeOptions: Array<ComposerPermissionOption>;
}

export function buildComposerControlsModel({
  session,
  backends,
}: {
  session?: SessionWire | null;
  backends: BackendWire[];
}): ComposerControlsModel {
  if (!session) {
    return {
      ready: false,
      disabled: true,
      providerLabel: "",
      modelOptions: [],
      reasoningEffortOptions: [],
      permissionModeOptions: [],
    };
  }

  const backend = session ? backends.find((candidate) => candidate.kind === session.backend) : undefined;
  const providerLabel = backend?.display_name ?? session?.runtime_info?.provider ?? session?.backend ?? "Agent";
  const currentConfig = session?.agent_config ?? {};
  const selectedModelId = currentConfig.model ?? session?.runtime_info?.model ?? session?.model ?? undefined;
  const selectedReasoningId =
    currentConfig.reasoning_effort ?? session?.runtime_info?.reasoning_effort ?? undefined;
  const selectedPermissionId =
    currentConfig.permission_mode ?? session?.runtime_info?.permission_mode ?? undefined;
  const modelOptions = ensureModelOption(
    (backend?.models ?? []).map(toModelOption),
    selectedModelId ?? undefined,
  );
  const selectedModel =
    modelOptions.find((option) => option.id === selectedModelId) ??
    modelOptions.find((option) => option.id && option.id === backend?.models.find((model) => model.is_default)?.id) ??
    modelOptions[0];
  const reasoningEffortOptions = selectedModel?.reasoningEfforts ?? [];
  const selectedReasoningEffort =
    reasoningEffortOptions.find((option) => option.id === selectedReasoningId) ??
    reasoningEffortOptions[0];
  const permissionModeOptions = ensurePermissionOption(
    backend?.permission_modes?.length
      ? backend.permission_modes.map(toPermissionOption)
      : DEFAULT_PERMISSION_MODE_OPTIONS,
    selectedPermissionId ?? undefined,
  );
  const selectedPermissionMode =
    permissionModeOptions.find((option) => option.id === selectedPermissionId) ??
    permissionModeOptions.find((option) => option.id === "auto") ??
    permissionModeOptions[0];
  const updateOperation = session?.operations?.update_agent_config;
  const backendSupportsAgentConfig = backend?.capabilities.session_agent_config !== false;

  return {
    ready: true,
    disabled: updateOperation?.available === false || !backendSupportsAgentConfig,
    providerLabel,
    selectedModel,
    selectedReasoningEffort,
    selectedPermissionMode,
    modelOptions,
    reasoningEffortOptions,
    permissionModeOptions,
  };
}

export function buildComposerSetupControlsModel({
  disabled = false,
  providerLabel,
  selectedModel,
  selectedReasoningEffort,
  selectedPermissionMode,
  modelOptions,
  reasoningEffortOptions,
  permissionModeOptions,
}: ComposerSetupControlsInput): ComposerControlsModel {
  const normalizedReasoningOptions = reasoningEffortOptions.map((option) => ({
    id: option.id,
    label: option.label,
    description: option.description,
  }));
  const normalizedModelOptions = modelOptions.map((option) => ({
    id: option.id,
    label: option.label,
    description: option.description,
    reasoningEfforts: normalizedReasoningOptions,
  }));
  const normalizedPermissionOptions = permissionModeOptions.map((option) => ({
    id: option.id,
    label: option.label,
    description: option.description,
  }));

  return {
    ready: true,
    disabled,
    providerLabel,
    selectedModel:
      normalizedModelOptions.find((option) => option.id === selectedModel) ??
      normalizedModelOptions[0],
    selectedReasoningEffort:
      normalizedReasoningOptions.find((option) => option.id === selectedReasoningEffort) ??
      normalizedReasoningOptions[0],
    selectedPermissionMode:
      normalizedPermissionOptions.find((option) => option.id === selectedPermissionMode) ??
      normalizedPermissionOptions.find((option) => option.id === "auto") ??
      normalizedPermissionOptions[0],
    modelOptions: normalizedModelOptions,
    reasoningEffortOptions: normalizedReasoningOptions,
    permissionModeOptions: normalizedPermissionOptions,
  };
}

function toModelOption(model: BackendModelWire): ComposerModelOption {
  return {
    id: model.id,
    label: model.label || model.id,
    description: model.description,
    reasoningEfforts: (model.reasoning_efforts ?? []).map(toReasoningOption),
  };
}

function toReasoningOption(option: ReasoningEffortOptionWire): ComposerOption {
  return {
    id: option.id,
    label: option.label || titleFromSnakeCase(option.id),
    description: option.description,
  };
}

function toPermissionOption(option: PermissionModeOptionWire): ComposerPermissionOption {
  return {
    id: option.id,
    label: option.label || titleFromSnakeCase(option.id),
    description: option.description,
  };
}

function ensureModelOption(
  options: ComposerModelOption[],
  selectedId: string | undefined,
): ComposerModelOption[] {
  if (!selectedId || options.some((option) => option.id === selectedId)) return options;
  return [
    ...options,
    {
      id: selectedId,
      label: selectedId,
      reasoningEfforts: [],
    },
  ];
}

function ensureOption(
  options: ComposerOption[],
  selectedId: string | undefined,
  labelFor: (id: string) => string,
): ComposerOption[] {
  if (!selectedId || options.some((option) => option.id === selectedId)) return options;
  return [...options, { id: selectedId, label: labelFor(selectedId) }];
}

function ensurePermissionOption(
  options: ComposerPermissionOption[],
  selectedId: PermissionModeWire | undefined,
): ComposerPermissionOption[] {
  if (!selectedId || options.some((option) => option.id === selectedId)) return options;
  return [...options, { id: selectedId, label: titleFromSnakeCase(selectedId) }];
}

function titleFromSnakeCase(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export const DEFAULT_PERMISSION_MODE_OPTIONS: ComposerPermissionOption[] = [
  { id: "auto", label: "Default permissions" },
  { id: "auto_review", label: "Auto review" },
  { id: "read_only", label: "Read only" },
  { id: "full_access", label: "Full access" },
];
