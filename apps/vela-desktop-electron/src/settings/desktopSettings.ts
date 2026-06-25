import type {
  BackendKindWire,
  BackendWire,
  VeladClient,
} from "../../../../packages/vela-chat-client/src";
import type { VelaSetting } from "../../../../packages/vela-settings/src";

export interface CreateDesktopSettingsInput {
  backends: BackendWire[];
  client: VeladClient;
  onBackendSettingsChange?: () => Promise<void> | void;
  onSelectedBackendChange: (backend: BackendKindWire) => void;
  selectedBackend: BackendKindWire | "";
}

export interface DesktopSettingsModel {
  engine: {
    backend: Array<VelaSetting<string>>;
    velaEngine: Array<VelaSetting<string>>;
  };
}

export function createDesktopSettings({
  backends,
  client,
  onBackendSettingsChange,
  onSelectedBackendChange,
  selectedBackend,
}: CreateDesktopSettingsInput): DesktopSettingsModel {
  const resolvedBackend =
    backends.find((backend) => backend.kind === selectedBackend) ?? backends[0] ?? null;

  return {
    engine: {
      backend: [
        {
          id: "runtime.defaultBackend",
          title: "默认 backend",
          description: `当前可用：${
            resolvedBackend?.display_name ?? "等待 velad 返回 backends"
          }`,
          control: "select",
          options: backends.map((backend) => ({
            value: backend.kind,
            label: backend.display_name,
            description:
              backend.status === "available"
                ? "Available"
                : backend.status === "degraded"
                  ? "Degraded"
                  : "Unavailable",
          })),
          load: () => resolvedBackend?.kind ?? "",
          save: (backend) => {
            if (backend) {
              onSelectedBackendChange(backend as BackendKindWire);
            }
          },
        },
      ],
      velaEngine: [
        {
          id: "velaEngine.endpoint",
          title: "Vela 内置引擎 Endpoint",
          description: "Chat Completions endpoint，保存后立即更新本机 runtime",
          control: "text",
          inputType: "url",
          load: async () =>
            (await client.getBackendSettings("vela_engine")).settings.endpoint ?? "",
          save: async (endpoint) => {
            await client.updateBackendSettings("vela_engine", { endpoint });
            await onBackendSettingsChange?.();
          },
        },
        {
          id: "velaEngine.apiKey",
          title: "Vela 内置引擎 Key",
          description: "由本机 velad 存储；保存后立即更新本机 runtime，值不会回显",
          control: "text",
          inputType: "password",
          load: async () => "",
          save: async (apiKey) => {
            await client.updateBackendSettings("vela_engine", { api_key: apiKey });
            await onBackendSettingsChange?.();
          },
        },
        {
          id: "velaEngine.model",
          title: "Vela 内置引擎 Model",
          description: "用于 Vela Engine 的默认 model name",
          control: "text",
          load: async () =>
            (await client.getBackendSettings("vela_engine")).settings.model ?? "",
          save: async (model) => {
            await client.updateBackendSettings("vela_engine", { model });
            await onBackendSettingsChange?.();
          },
        },
      ],
    },
  };
}
