export interface LibraryView {
  readonly id: string;
  readonly name: string;
  readonly kind: "nfs";
  readonly managedBy: "e2b";
  readonly mountPath: "/shared";
  readonly verifiedAt: string;
  readonly source: "platform";
  readonly environmentIds: string[];
  readonly status: "configured" | "unavailable";
}
export type AssetSource = "personal" | "platform";
/** Platform custody is chosen only by server policy, never an arbitrary request scope. */
export const PLATFORM_ASSET_SCOPE = "platform:assistant-environments";
export const assetSource = (value: { source?: AssetSource }): AssetSource => value.source ?? "personal";
export interface E2BCredential {
  source?: AssetSource;
  id: string;
  name: string;
  apiUrl: string;
  sandboxUrl: string;
  generation: string;
}
export interface SandboxConfiguration {
  source?: AssetSource;
  id: string;
  name: string;
  credentialId?: string;
  templateId: string;
}
export interface SandboxConfigurationsSnapshot {
  scope: string;
  revision: number;
  allowCustomEndpoints: boolean;
  canManagePlatform?: boolean;
  platformRevision?: number;
  libraryRevision?: number;
  libraries?: LibraryView[];
  credentials: E2BCredential[];
  environments: SandboxConfiguration[];
}
export type SandboxConfigurationInput = {
  revision: number;
  source?: AssetSource;
} & (
  | {
      action: "save-credential";
      id?: string;
      name: string;
      apiUrl: string;
      sandboxUrl: string;
      apiKey?: string;
    }
  | { action: "delete-credential"; id: string }
  | {
      action: "save-environment";
      id?: string;
      name: string;
      credentialId: string;
      templateId: string;
    }
  | { action: "delete-environment"; id: string }
);
