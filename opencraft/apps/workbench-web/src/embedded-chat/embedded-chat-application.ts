import { createEmbeddedAccountStorage } from "./embedded-account-storage";
import {
  createWebWorkbenchApplication,
  type WebWorkbenchApplication,
} from "../runtime/web-workbench-application";
import {
  embeddedHostProfile,
  type EmbeddedHostProfileOptions,
} from "./embedded-host-profile";

export interface EmbeddedChatApplicationOptions extends EmbeddedHostProfileOptions {
  readonly apiBase?: string;
  readonly getSessionToken?: () => string | null;
}

export interface EmbeddedChatApplication {
  readonly application: WebWorkbenchApplication;
  readonly hostId: string;
  dispose(): Promise<void>;
}

export async function createEmbeddedChatApplication(
  options: EmbeddedChatApplicationOptions,
): Promise<EmbeddedChatApplication> {
  const profile = embeddedHostProfile(options);
  // Browser pages and conversation bindings belong to this Bot lifetime.
  // Never restore standalone or another embedded account's browser metadata.
  const browserMetadata = new Map<string, string>();
  const application = await createWebWorkbenchApplication({
    browserMetadataStorage: {
      getItem: key => browserMetadata.get(key) ?? null,
      setItem: (key, value) => { browserMetadata.set(key, value); },
    },
    ephemeralHostProfiles: [profile],
    hostProfileMode: "configured",
    modelSelectionPolicy: "host-default",
    lightVelaApiBase: options.apiBase,
    lightVelaAccountStorage: options.getSessionToken
      ? createEmbeddedAccountStorage(options.getSessionToken)
      : undefined,
    lightVelaRegion: options.region,
    navigationMode: "memory",
  });
  try {
    if (application.supervisor.mode !== "active") {
      throw new Error("Embedded Chat could not construct an active OpenCraft Host");
    }
    return {
      application,
      hostId: profile.hostId,
      dispose: () => application.dispose(),
    };
  } catch (error) {
    await application.dispose().catch(() => undefined);
    throw error;
  }
}
