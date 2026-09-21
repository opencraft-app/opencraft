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
  const application = await createWebWorkbenchApplication({
    ephemeralHostProfiles: [profile],
    hostProfileMode: "configured",
    lightVelaApiBase: options.apiBase,
    lightVelaRegion: options.region,
    navigationMode: "memory",
  });
  try {
    if (application.supervisor.mode !== "active") {
      throw new Error("Embedded Chat could not construct an active OpenCraft Host");
    }
    await application.supervisor.registry.ensureConnected(profile.hostId);
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
