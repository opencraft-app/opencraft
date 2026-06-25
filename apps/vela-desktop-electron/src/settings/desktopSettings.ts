import type {
  BackendKindWire,
  BackendWire,
} from "../../../../packages/vela-chat-client/src";
import type { VelaSetting } from "../../../../packages/vela-settings/src";
import {
  readVelaEngineSettings,
  saveVelaEngineSettings,
} from "../desktopBridge";

export interface CreateDesktopSettingsInput {
  backends: BackendWire[];
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
          description: "Chat Completions endpoint，保存后重启本地 runtime 生效",
          control: "text",
          inputType: "url",
          load: async () => (await readVelaEngineSettings()).endpoint,
          save: async (endpoint) => {
            await saveVelaEngineSettings({ endpoint });
          },
        },
        {
          id: "velaEngine.apiKey",
          title: "Vela 内置引擎 Key",
          description: "仅保存在本机 Electron userData，保存后重启本地 runtime 生效",
          control: "text",
          inputType: "password",
          load: async () => (await readVelaEngineSettings()).apiKey,
          save: async (apiKey) => {
            await saveVelaEngineSettings({ apiKey });
          },
        },
        {
          id: "velaEngine.model",
          title: "Vela 内置引擎 Model",
          description: "用于 Vela Engine 的默认 model name",
          control: "text",
          load: async () => (await readVelaEngineSettings()).model,
          save: async (model) => {
            await saveVelaEngineSettings({ model });
          },
        },
      ],
    },
  };
}
