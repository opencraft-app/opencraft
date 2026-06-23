import type {
  AgentConfigWire,
  BackendKindWire,
  BackendWire,
  PermissionModeWire,
} from "../../vela-chat-client/src";
import { DEFAULT_PERMISSION_MODE_OPTIONS } from "../../vela-chat-web/src/components/composer-controls/model";

export interface VelaSessionSetupSelectionInput {
  backends: BackendWire[];
  selectedBackend: BackendKindWire | "";
  selectedModel: string;
  selectedReasoningEffort: string;
  selectedPermissionMode: PermissionModeWire | "";
}

export function buildVelaSessionSetupSelection({
  backends,
  selectedBackend,
  selectedModel,
  selectedReasoningEffort,
  selectedPermissionMode,
}: VelaSessionSetupSelectionInput) {
  const selectedBackendDetails =
    backends.find((backend) => backend.kind === selectedBackend) ?? backends[0];
  const resolvedSelectedBackend = selectedBackendDetails?.kind ?? selectedBackend;
  const backendKinds = new Set(backends.map((backend) => backend.kind));
  const setupModelOptions = selectedBackendDetails?.models ?? [];
  const setupSelectedModel =
    selectedModel && setupModelOptions.some((model) => model.id === selectedModel)
      ? selectedModel
      : setupModelOptions.find(isDefaultOption)?.id ??
        setupModelOptions[0]?.id ??
        selectedModel;
  const modelReasoningOptions =
    setupModelOptions.find((model) => model.id === setupSelectedModel)?.reasoning_efforts ?? [];
  const setupReasoningOptions = modelReasoningOptions;
  const setupSelectedReasoningEffort =
    selectedReasoningEffort &&
    setupReasoningOptions.some((option) => option.id === selectedReasoningEffort)
      ? selectedReasoningEffort
      : setupReasoningOptions.find(isDefaultOption)?.id ??
        setupReasoningOptions[0]?.id ??
        "";
  const setupPermissionOptions = selectedBackendDetails?.permission_modes?.length
    ? selectedBackendDetails.permission_modes
    : DEFAULT_PERMISSION_MODE_OPTIONS;
  const setupSelectedPermissionMode =
    selectedPermissionMode &&
    setupPermissionOptions.some((option) => option.id === selectedPermissionMode)
      ? selectedPermissionMode
      : setupPermissionOptions.find(isDefaultOption)?.id ??
        setupPermissionOptions.find((option) => option.id === "auto")?.id ??
        setupPermissionOptions[0]?.id ??
        selectedPermissionMode;
  const setupAgentConfig: AgentConfigWire = {
    ...(setupSelectedModel ? { model: setupSelectedModel } : {}),
    ...(setupSelectedReasoningEffort ? { reasoning_effort: setupSelectedReasoningEffort } : {}),
    ...(setupSelectedPermissionMode ? { permission_mode: setupSelectedPermissionMode } : {}),
  };

  return {
    selectedBackendDetails,
    resolvedSelectedBackend,
    backendKinds,
    setupModelOptions,
    setupSelectedModel,
    setupReasoningOptions,
    setupSelectedReasoningEffort,
    setupPermissionOptions,
    setupSelectedPermissionMode,
    setupAgentConfig,
  };
}

function isDefaultOption(option: unknown) {
  return (
    typeof option === "object" &&
    option !== null &&
    "is_default" in option &&
    option.is_default === true
  );
}

