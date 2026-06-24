import type {
  BackendKindWire,
  BackendWire,
} from "../../../../packages/vela-chat-client/src";
import type { VelaSetting } from "../../../../packages/vela-settings/src";

export interface CreateDesktopSettingsInput {
  backends: BackendWire[];
  onSelectedBackendChange: (backend: BackendKindWire) => void;
  selectedBackend: BackendKindWire | "";
}

export function createDesktopSettings({
  backends,
  onSelectedBackendChange,
  selectedBackend,
}: CreateDesktopSettingsInput): Array<VelaSetting<BackendKindWire | "">> {
  const resolvedBackend =
    backends.find((backend) => backend.kind === selectedBackend) ?? backends[0] ?? null;

  return [
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
          onSelectedBackendChange(backend);
        }
      },
    },
  ];
}

