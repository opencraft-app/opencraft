/** Stable AppServer extension for Profile-owned Skill administration. */
export const OPENCRAFT_PROFILE_SKILLS_EXTENSION = "opencraft/profile-skills";

export interface ProfileSkillsCapability {
  readonly version: 1;
  readonly features: {
    readonly contentRead: boolean;
    readonly officialCatalog: boolean;
    readonly catalogSearch: boolean;
    readonly catalogPreview: boolean;
    readonly catalogScan: boolean;
    readonly install: boolean;
    readonly uninstall: boolean;
    readonly update: boolean;
    readonly enablement: boolean;
    readonly actionNotifications: boolean;
  };
  readonly limits: {
    readonly maxPageSize: number;
    readonly maxActionLogLines: number;
  };
}

export const OPENCRAFT_PROFILE_SKILLS_CAPABILITY: ProfileSkillsCapability =
  Object.freeze({
    version: 1,
    features: Object.freeze({
      contentRead: true,
      officialCatalog: true,
      catalogSearch: true,
      catalogPreview: true,
      catalogScan: true,
      install: true,
      uninstall: true,
      update: true,
      enablement: true,
      actionNotifications: true,
    }),
    limits: Object.freeze({
      maxPageSize: 100,
      maxActionLogLines: 500,
    }),
  });

export interface ProfileSkillScope {
  readonly type: "profile";
  readonly profileId: string;
}

export interface ProfileSkillInstalled {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly enabled: boolean;
  readonly provenance: "bundled" | "catalog" | "local" | "unknown";
  readonly usageCount?: number;
  readonly catalogIdentifier?: string;
}

export interface ProfileSkillCatalogInstalledState {
  readonly name?: string;
  readonly trustLevel?: string;
  readonly scanVerdict?: string;
}

export interface ProfileSkillCatalogEntry {
  readonly identifier: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly trustLevel?: string;
  readonly repositoryUrl?: string;
  readonly tags: readonly string[];
  readonly installed?: ProfileSkillCatalogInstalledState;
}

export interface ProfileSkillCatalogSource {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly searchable: boolean;
  readonly rateLimited: boolean;
}

export interface ProfileSkillScanFinding {
  readonly severity: string;
  readonly category: string;
  readonly file: string;
  readonly line?: number;
  readonly description: string;
}

export interface ProfileSkillScan {
  readonly identifier: string;
  readonly name: string;
  readonly source: string;
  readonly trustLevel: string;
  readonly verdict: string;
  readonly summary: string;
  readonly policy: "allow" | "ask" | "block";
  readonly policyReason?: string;
  readonly findings: readonly ProfileSkillScanFinding[];
  readonly severityCounts: Readonly<Record<string, number>>;
}

export type ProfileSkillActionKind = "install" | "uninstall" | "update";
export type ProfileSkillActionState =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProfileSkillsErrorCode =
  | "PROFILE_NOT_FOUND"
  | "SKILL_NOT_FOUND"
  | "CATALOG_ENTRY_NOT_FOUND"
  | "INVALID_IDENTIFIER"
  | "ALREADY_INSTALLED"
  | "NOT_INSTALLED"
  | "REVISION_MISMATCH"
  | "OPERATION_CONFLICT"
  | "ACTION_NOT_FOUND"
  | "ACTION_EXPIRED"
  | "POLICY_BLOCKED"
  | "SOURCE_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "UNSUPPORTED_OPERATION"
  | "INTERNAL";

export interface ProfileSkillsErrorData {
  readonly domain: "profile-skills";
  readonly code: ProfileSkillsErrorCode;
  readonly retryable: boolean;
  readonly scope?: ProfileSkillScope;
  readonly actionId?: string;
  readonly operationId?: string;
  readonly currentRevision?: string;
}

export interface ProfileSkillAction {
  readonly actionId: string;
  readonly operationId: string;
  readonly scope: ProfileSkillScope;
  readonly kind: ProfileSkillActionKind;
  readonly target?: string;
  readonly state: ProfileSkillActionState;
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
  readonly exitCode?: number;
  readonly logLines: readonly string[];
  readonly logCursor?: string;
  readonly error?: ProfileSkillsErrorData;
}

export interface ProfileSkillsInstalledListParams {
  readonly scope: ProfileSkillScope;
  readonly cursor?: string;
  readonly limit?: number;
  readonly forceReload?: boolean;
}

export interface ProfileSkillsInstalledListResult {
  readonly data: readonly ProfileSkillInstalled[];
  readonly nextCursor: string | null;
  readonly revision: string;
}

export interface ProfileSkillsContentReadParams {
  readonly scope: ProfileSkillScope;
  readonly name: string;
}

export interface ProfileSkillsContentReadResult {
  readonly name: string;
  readonly content: string;
  readonly revision: string;
}

export interface ProfileSkillsEnabledSetParams {
  readonly scope: ProfileSkillScope;
  readonly name: string;
  readonly enabled: boolean;
  readonly expectedRevision: string;
  readonly operationId: string;
}

export interface ProfileSkillsEnabledSetResult {
  readonly name: string;
  readonly enabled: boolean;
  readonly revision: string;
  readonly operationId: string;
}

export interface ProfileSkillsCatalogSourcesListParams {
  readonly scope: ProfileSkillScope;
}

export interface ProfileSkillsCatalogSourcesListResult {
  readonly data: readonly ProfileSkillCatalogSource[];
  readonly indexAvailable: boolean;
  readonly featured: readonly ProfileSkillCatalogEntry[];
  readonly revision: string;
}

export interface ProfileSkillsCatalogOfficialListParams {
  readonly scope: ProfileSkillScope;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ProfileSkillsCatalogOfficialListResult {
  readonly data: readonly ProfileSkillCatalogEntry[];
  readonly nextCursor: string | null;
  readonly revision: string;
}

export interface ProfileSkillsCatalogSearchParams {
  readonly scope: ProfileSkillScope;
  readonly query: string;
  readonly source?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ProfileSkillsCatalogSearchResult {
  readonly data: readonly ProfileSkillCatalogEntry[];
  readonly nextCursor: string | null;
  readonly sourceCounts: Readonly<Record<string, number>>;
  readonly timedOutSources: readonly string[];
}

export interface ProfileSkillsCatalogPreviewParams {
  readonly scope: ProfileSkillScope;
  readonly identifier: string;
}

export interface ProfileSkillsCatalogPreviewResult {
  readonly entry: ProfileSkillCatalogEntry;
  readonly skillMarkdown: string;
  readonly files: readonly string[];
}

export interface ProfileSkillsCatalogScanParams {
  readonly scope: ProfileSkillScope;
  readonly identifier: string;
}

export interface ProfileSkillsCatalogScanResult {
  readonly scan: ProfileSkillScan;
}

export interface ProfileSkillsMutationBase {
  readonly scope: ProfileSkillScope;
  readonly expectedRevision?: string;
  readonly operationId: string;
}

export interface ProfileSkillsInstallParams extends ProfileSkillsMutationBase {
  readonly identifier: string;
}

export interface ProfileSkillsUninstallParams extends ProfileSkillsMutationBase {
  readonly name: string;
}

export type ProfileSkillsUpdateParams = ProfileSkillsMutationBase;

export interface ProfileSkillsActionResult {
  readonly action: ProfileSkillAction;
}

export interface ProfileSkillsActionReadParams {
  readonly scope: ProfileSkillScope;
  readonly actionId: string;
  readonly logCursor?: string;
  readonly maxLogLines?: number;
}

export interface ProfileSkillsMethodMap {
  "skills/installed/list": {
    params: ProfileSkillsInstalledListParams;
    result: ProfileSkillsInstalledListResult;
  };
  "skills/installed/content/read": {
    params: ProfileSkillsContentReadParams;
    result: ProfileSkillsContentReadResult;
  };
  "skills/enabled/set": {
    params: ProfileSkillsEnabledSetParams;
    result: ProfileSkillsEnabledSetResult;
  };
  "skills/catalog/sources/list": {
    params: ProfileSkillsCatalogSourcesListParams;
    result: ProfileSkillsCatalogSourcesListResult;
  };
  "skills/catalog/official/list": {
    params: ProfileSkillsCatalogOfficialListParams;
    result: ProfileSkillsCatalogOfficialListResult;
  };
  "skills/catalog/search": {
    params: ProfileSkillsCatalogSearchParams;
    result: ProfileSkillsCatalogSearchResult;
  };
  "skills/catalog/preview": {
    params: ProfileSkillsCatalogPreviewParams;
    result: ProfileSkillsCatalogPreviewResult;
  };
  "skills/catalog/scan": {
    params: ProfileSkillsCatalogScanParams;
    result: ProfileSkillsCatalogScanResult;
  };
  "skills/install": {
    params: ProfileSkillsInstallParams;
    result: ProfileSkillsActionResult;
  };
  "skills/uninstall": {
    params: ProfileSkillsUninstallParams;
    result: ProfileSkillsActionResult;
  };
  "skills/update": {
    params: ProfileSkillsUpdateParams;
    result: ProfileSkillsActionResult;
  };
  "skills/action/read": {
    params: ProfileSkillsActionReadParams;
    result: ProfileSkillsActionResult;
  };
}

export type ProfileSkillsMethod = keyof ProfileSkillsMethodMap & string;
export type ProfileSkillsMethodParams<TMethod extends ProfileSkillsMethod> =
  ProfileSkillsMethodMap[TMethod]["params"];
export type ProfileSkillsMethodResult<TMethod extends ProfileSkillsMethod> =
  ProfileSkillsMethodMap[TMethod]["result"];

export type ProfileSkillsEvent =
  | { readonly method: "skills/action/updated"; readonly params: { readonly action: ProfileSkillAction } }
  | {
      readonly method: "skills/installed/changed";
      readonly params: {
        readonly scope: ProfileSkillScope;
        readonly revision: string;
        readonly cause: "install" | "uninstall" | "update" | "enablement" | "external";
        readonly actionId?: string;
      };
    };

export function isProfileSkillScope(value: unknown): value is ProfileSkillScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ProfileSkillScope>;
  return candidate.type === "profile"
    && typeof candidate.profileId === "string"
    && candidate.profileId.trim().length > 0;
}

export function isProfileSkillsEvent(value: unknown): value is ProfileSkillsEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as { readonly method?: unknown; readonly params?: unknown };
  if (event.method !== "skills/action/updated" && event.method !== "skills/installed/changed") return false;
  return typeof event.params === "object" && event.params !== null && !Array.isArray(event.params);
}
