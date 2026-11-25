import { createAppHostAdmission } from "./app-host-admission";
import { mobileContainer } from "./mobile-container";
import { parseWebDeploymentConfig, resolveWebDeploymentConfig } from "./web-deployment-config";
import { parseWebHostDefinitions } from "./web-host-definition";
import { resolveClientRuntimeKind } from "./window-presentation";
import { parseWorkbenchLocationUrl } from "./workbench-location-url";

export async function prepareDeploymentAppHost(signal: AbortSignal) {
  if (signal.aborted || resolveClientRuntimeKind(window) !== "web" || mobileContainer()) return null;
  const location = parseWorkbenchLocationUrl(new URL(window.location.href));
  if (location?.kind !== "thread") return null;
  const configuration = parseWebDeploymentConfig(
    document.getElementById("opencraft-deployment-config")?.textContent ?? null,
  );
  const definitions = parseWebHostDefinitions(
    resolveWebDeploymentConfig(configuration, {
      hosts: import.meta.env.VITE_APPSERVER_HOSTS_JSON,
    }).hosts,
  );
  const hostId = location.key.hostId;
  if (!definitions.some((host) => host.hostId === hostId && host.appHost)) return null;

  let observe: ((status: number) => void) | undefined;
  let statusBeforeClaim: number | undefined;
  const admission = createAppHostAdmission(undefined, (status) => {
    if (observe) observe(status);
    else statusBeforeClaim = status;
  });
  // Reuse the first admission result even if the transport module loads after
  // the HTTP check settles. Later physical connections run fresh admission.
  let firstAdmission: Promise<void> | undefined = admission.prepare();
  void firstAdmission.catch(() => undefined);
  let closeConnection: (() => void) | undefined;
  let claimed = false;
  const close = () => {
    admission.dispose();
    closeConnection?.();
  };
  signal.addEventListener("abort", close, { once: true });

  let connection: ReturnType<typeof import("./websocket-app-host").connectWebSocketAppHost>;
  try {
    const { connectWebSocketAppHost } = await import("./websocket-app-host");
    if (signal.aborted) return null;
    connection = connectWebSocketAppHost(undefined, {
      beforeConnect: () => {
        const prepared = firstAdmission;
        firstAdmission = undefined;
        return prepared ?? admission.prepare();
      },
    });
    closeConnection = connection.close;
  } catch (error) {
    signal.removeEventListener("abort", close);
    close();
    throw error;
  }
  const transport = connection.createTransport(hostId);
  let firstTransport: typeof transport | undefined = transport;
  void transport.connect().catch(() => undefined);

  return {
    claim(selectedHostId: string | undefined, observer: (status: number) => void) {
      if (claimed || signal.aborted) return null;
      claimed = true;
      signal.removeEventListener("abort", close);
      if (selectedHostId !== hostId) {
        close();
        return null;
      }
      observe = observer;
      if (statusBeforeClaim !== undefined) observe(statusBeforeClaim);
      return {
        hostId,
        admission,
        connection: {
          close,
          createTransport(id: string) {
            if (id !== hostId || !firstTransport) return connection.createTransport(id);
            const ready = firstTransport;
            firstTransport = undefined;
            return ready;
          },
        },
      };
    },
  };
}

export type PreparedDeploymentAppHost = Awaited<ReturnType<typeof prepareDeploymentAppHost>>;
