import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { codexPermissionMode, parsePermissionModeProfileId } from "@opencraft/appserver-protocol";
import type { BridgeGatewayOptions } from "@opencraft/agent-bridge-host/gateway";
import { codexAttachmentsService } from "./codex-attachments-service.js";
import { codexContinuationService, type CodexContinuationService } from "./codex-continuation-service.js";
import {
  CodexHostServices,
  codexAccountsService,
  codexMaintenanceService,
  codexModelsService,
  codexPinsService,
  codexTasksService,
  codexTitlesService,
  type CodexHostService,
} from "./codex-host-services.js";
import { codexAdmissionPaused } from "./codex-maintenance.js";
import { CodexNativeFallback } from "./codex-native-fallback.js";
import { CodexNativeReader } from "./codex-native-reader.js";
import { CodexProviderBridge } from "./codex-provider-bridge.js";
import { codexSchedulesService } from "./codex-schedules-service.js";
import { codexLegacyHandoffService } from "./codex-legacy-handoff.js";

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};

export interface CodexBridgeHostOptions {
  /** Core's control endpoint and token: accounts, and the native AppServer the Host's own connection reads. */
  readonly coreEndpoint: string;
  readonly coreAuthToken: string;
  readonly bridge: BridgeGatewayOptions;
  /** The Codex data directory; the local Host's durable records live here and carry over. */
  readonly codexDataDirectory: string;
  readonly artifactDirectory?: string;
  /** Called whenever a store reports how it opened. */
  readonly storageOpened?: () => void;
}

/**
 * The local Codex Host with every Thread on the provider bridge and no legacy
 * Host underneath:
 *
 *   Host services (accounts, tasks, models, pins, titles, attachments,
 *   continuation, schedules, maintenance)
 *     → provider bridge (owns every Thread; adopts existing ones on first use)
 *       → native fallback (initialize, catalog, reads of Threads not yet moved)
 *
 * Duties acting on a Thread go through the bridge as the Host's own client.
 */
export function createCodexBridgeHost(options: CodexBridgeHostOptions): CodexHostServices {
  const directory = options.codexDataDirectory;
  const reader = new CodexNativeReader(options.coreEndpoint, options.coreAuthToken);
  const control = new CodexCoreControlClient(options.coreEndpoint, options.coreAuthToken);
  const paused = () => codexAdmissionPaused(directory);
  const attachments = codexAttachmentsService({
    directory,
    artifactDirectory: options.artifactDirectory,
    codexHome: async () => {
      const home = object(await reader.initializeResult()).codexHome;
      return typeof home === "string" ? home : undefined;
    },
  });
  const bridge = new CodexProviderBridge(new CodexNativeFallback(reader), options.bridge, {
    exclusive: true,
    resolvePermissions: (selection, cwd) => resolveCodexPermissions(reader, selection, cwd),
    projectlessWorkspace: async () => {
      const root = join(directory, "projectless-workspaces");
      await mkdir(root, { recursive: true, mode: 0o700 });
      return mkdtemp(join(root, "thread-"));
    },
    admissionPaused: paused,
    prepareInput: (threadId, clientId, input) => attachments.prepareInput(threadId, clientId, input),
    projectHistory: (method, params, result) => attachments.projectHistory(method, params, result),
    // No local Host holds Threads; whatever it left durable is carried by the services above.
    releaseForAdoption: async () => true,
  });
  const identities = bridge.threadIdentities();
  let continuation: CodexContinuationService | undefined;
  let titles: ReturnType<typeof codexTitlesService> | undefined;
  return new CodexHostServices(
    bridge,
    (clients) => {
      titles = codexTitlesService(reader, clients, identities);
      continuation = codexContinuationService({
        directory,
        clients,
        admissionOpen: () => !paused(),
        accounts: async () => object(await control.accountRequest("opencraft/codex/accounts/list", {})).accounts,
        native: reader,
        identities,
      });
      const services: CodexHostService[] = [
        codexTasksService(join(directory, "tasks.sqlite"), clients, () => options.storageOpened?.()),
        codexAccountsService(control),
        codexModelsService(reader),
        codexPinsService(reader, clients, identities),
        titles,
        attachments,
        continuation,
        codexSchedulesService({ directory, clients, native: reader, admissionOpen: () => !paused() }),
        codexMaintenanceService({
          paused,
          bridge: () => bridge.maintenance(),
          continuation: () => continuation!.counts(),
          pendingTitles: () => titles!.pendingCount(),
        }),
        // Inputs the local Host still had queued move to the Host queue of their Thread.
        codexLegacyHandoffService(directory, clients),
        { handles: () => false, request: () => null, close: () => reader.close() },
      ];
      return services;
    },
    (listener) => bridge.observeEvents(listener),
  );
}

/**
 * An OpenCraft permission mode (`opencraft:permission-mode:*`) names the native
 * profile with that mode and binds approvals with it, as the local Host did;
 * any other selection is a native profile ID and passes unchanged.
 */
export async function resolveCodexPermissions(
  native: { request(method: string, params: Value): Promise<unknown> },
  selection: string,
  cwd: unknown,
): Promise<Value> {
  const mode = parsePermissionModeProfileId(selection);
  if (mode === null) return { permissions: selection };
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const result = object(
      await native.request("permissionProfile/list", {
        cursor,
        limit: 100,
        ...(typeof cwd === "string" ? { cwd } : {}),
      }),
    );
    if (!Array.isArray(result.data)) throw new Error("Codex permission catalog is unavailable");
    for (const entry of result.data.map(object)) {
      if (codexPermissionMode(String(entry.id ?? "")) !== mode) continue;
      if (entry.allowed !== true) throw new Error(`Permission mode is disabled by Codex requirements: ${mode}`);
      return { permissions: entry.id, approvalPolicy: mode === "full" ? "never" : "on-request" };
    }
    if (result.nextCursor == null) break;
    if (typeof result.nextCursor !== "string" || result.nextCursor === cursor)
      throw new Error("Codex permission catalog did not advance");
    cursor = result.nextCursor;
  }
  throw new Error(`Permission mode is unavailable on this Codex Host: ${mode}`);
}
