export type ExtensionPlatform = "web" | "electron" | "expo";
export type ExtensionTrust = "trusted";
export type ExtensionActivationEvent =
  | "onStartupFinished"
  | "*"
  | `onCommand:${string}`
  | `onView:${string}`;

export type ExtensionDisposable = () => void | Promise<void>;

export interface ExtensionManifestV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly trust: ExtensionTrust;
  readonly platforms: readonly ExtensionPlatform[];
  readonly activationEvents: readonly ExtensionActivationEvent[];
  /** Required extensions that must already be active before this extension. */
  readonly dependencies?: readonly string[];
  readonly description?: string;
}

export interface ExtensionActivationIdentity {
  readonly extensionId: string;
  readonly activationId: string;
  readonly generation: number;
}

export type ExtensionJson =
  | null
  | boolean
  | number
  | string
  | readonly ExtensionJson[]
  | { readonly [key: string]: ExtensionJson };

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly when?: string;
}

export type CommandHandler = (
  ...arguments_: readonly ExtensionJson[]
) => ExtensionJson | void | Promise<ExtensionJson | void>;

export type SettingsFieldContribution =
  | {
      readonly key: string;
      readonly type: "boolean";
      readonly title: string;
      readonly description?: string;
      readonly defaultValue: boolean;
    }
  | {
      readonly key: string;
      readonly type: "string" | "number";
      readonly title: string;
      readonly description?: string;
      readonly defaultValue?: string | number;
    }
  | {
      readonly key: string;
      readonly type: "select";
      readonly title: string;
      readonly description?: string;
      readonly defaultValue?: string;
      readonly options: readonly {
        readonly value: string;
        readonly label: string;
      }[];
    };

export interface SettingsSchemaContribution {
  readonly id: string;
  readonly title: string;
  readonly schemaVersion: number;
  readonly fields: readonly SettingsFieldContribution[];
}

/**
 * A View declares what can be rendered. It deliberately says nothing about
 * where an instance is presented. Workspace/navigation surfaces own
 * placement, responsive projection and lifetime.
 */
export interface ViewContribution {
  readonly id: string;
  readonly title: string;
  readonly viewType: string;
  /**
   * Optional host-facing capability supplied by this view. Consumers bind to
   * the capability instead of importing an extension's concrete view id.
   */
  readonly role?: "bot-conversation";
  readonly icon?: string;
  readonly platforms?: readonly ExtensionPlatform[];
}

export type NavigationSurface = "sidebar-primary" | "sidebar-footer";

export type NavigationTarget =
  | { readonly kind: "command"; readonly commandId: string }
  | { readonly kind: "settings"; readonly pageId: string }
  | { readonly kind: "view"; readonly viewId: string };

/** A host-rendered entry point. Extensions never inject sidebar DOM. */
export interface NavigationContribution {
  readonly id: string;
  readonly title: string;
  readonly surface: NavigationSurface;
  readonly target: NavigationTarget;
  readonly order?: number;
  readonly icon?: string;
  readonly platforms?: readonly ExtensionPlatform[];
}

/**
 * A host-owned collapsible sidebar section whose body resolves a registered
 * View. The shell owns heading, spacing, collapse, overflow and responsive
 * projection; the View owns only its content.
 */
export interface SidebarCatalogContribution {
  readonly id: string;
  readonly title: string;
  readonly viewId: string;
  readonly order?: number;
  readonly icon?: string;
  readonly initiallyCollapsed?: boolean;
  readonly platforms?: readonly ExtensionPlatform[];
}

/** A settings navigation entry that presents a registered View. */
export interface SettingsPageContribution {
  readonly id: string;
  readonly title: string;
  readonly viewId: string;
  readonly order?: number;
  readonly icon?: string;
  readonly platforms?: readonly ExtensionPlatform[];
  /** The settings shell owns viewport geometry for collection/detail pages. */
  readonly layout?: "document" | "master-detail";
  readonly group?: string;
  /**
   * Declares that this page belongs to one target-management surface instead
   * of the device-global Settings index. Pages in the same family share the
   * shell's selected Agent/Host context; the extension still owns their data
   * and rendering.
   */
  readonly management?: {
    readonly familyId: string;
    readonly scope: "agent" | "host";
  };
}

export type WorkbenchSurface = "empty-workbench" | "host-connection-intervention";

interface WorkbenchSurfaceContributionBase {
  readonly id: string;
  readonly viewId: string;
  readonly order?: number;
  readonly platforms?: readonly ExtensionPlatform[];
}

/** A presentation request for a host-owned Workbench surface. */
export type WorkbenchSurfaceContribution = WorkbenchSurfaceContributionBase & (
  | {
      readonly surface: "empty-workbench";
      readonly providerId?: never;
      readonly intervention?: never;
    }
  | {
      readonly surface: "host-connection-intervention";
      readonly providerId: string;
      readonly intervention: "authentication-required" | "configuration-required";
    }
);

export type BotAvatarContribution =
  | {
      readonly kind: "image-url";
      readonly url: string;
      readonly alt?: string;
    }
  | {
      readonly kind: "monogram";
      readonly text: string;
      readonly background: string;
      readonly foreground?: string;
    }
  | {
      /** Stable seed; the Host chooses the platform-specific living shape. */
      readonly kind: "generated";
      readonly seed: string;
      readonly palette?: string;
    }
  | {
      /** Host-resolved avatar resource. It is not assumed to be a browser URL. */
      readonly kind: "resource";
      readonly uri: string;
    };

export type BotActionContribution =
  | { readonly kind: "external-url"; readonly url: string }
  | { readonly kind: "command"; readonly commandId: string }
  | {
      readonly kind: "view";
      readonly viewId: string;
      /** Opaque View-owned selection or resource identity. */
      readonly resourceUri?: string;
    };

/**
 * A semantic Bot identity. A separate presentation extension decides where
 * and how Bots appear; providers never inject shell DOM.
 */
export interface BotContribution {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly avatar: BotAvatarContribution;
  readonly availability?: "available" | "connecting" | "unavailable" | "disabled";
  readonly action: BotActionContribution;
  readonly defaultPinned?: boolean;
  readonly order?: number;
  readonly platforms?: readonly ExtensionPlatform[];
}

export interface ThemePaletteContribution {
  /** Strict #RRGGBB colors; the Host derives all semantic CSS/native tokens. */
  readonly accent: string;
  readonly contrast: number;
  readonly ink: string;
  readonly surface: string;
  readonly semanticColors: {
    readonly diffAdded: string;
    readonly diffRemoved: string;
    readonly skill: string;
  };
}

/**
 * Theme extensions contribute palette inputs, never arbitrary CSS. Both
 * variants are required so `system` selection is deterministic on every Host.
 */
export interface ThemeContribution {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly palettes: {
    readonly light: ThemePaletteContribution;
    readonly dark: ThemePaletteContribution;
  };
}

export interface ExtensionSubscriptionsApiV1 {
  add(disposable: ExtensionDisposable): ExtensionDisposable;
}

export interface ExtensionCommandsApiV1 {
  register(
    contribution: CommandContribution,
    handler: CommandHandler,
  ): ExtensionDisposable;
}

export interface ExtensionSettingsApiV1 {
  registerSchema(contribution: SettingsSchemaContribution): ExtensionDisposable;
  registerPage(contribution: SettingsPageContribution): ExtensionDisposable;
}

export interface ExtensionViewsApiV1 {
  register(contribution: ViewContribution): ExtensionDisposable;
}

export interface ExtensionNavigationApiV1 {
  register(contribution: NavigationContribution): ExtensionDisposable;
}

export interface ExtensionSidebarApiV1 {
  registerCatalog(contribution: SidebarCatalogContribution): ExtensionDisposable;
}

export interface ExtensionWorkbenchApiV1 {
  registerSurface(contribution: WorkbenchSurfaceContribution): ExtensionDisposable;
}

export interface ExtensionThemesApiV1 {
  register(contribution: ThemeContribution): ExtensionDisposable;
}

export interface ExtensionBotsApiV1 {
  register(contribution: BotContribution): ExtensionDisposable;
}

/** Stable, UI-framework-free API exposed to trusted V1 extensions. */
export interface OpenCraftExtensionApiV1 {
  readonly identity: ExtensionActivationIdentity;
  readonly subscriptions: ExtensionSubscriptionsApiV1;
  readonly commands: ExtensionCommandsApiV1;
  readonly settings: ExtensionSettingsApiV1;
  readonly views: ExtensionViewsApiV1;
  readonly navigation: ExtensionNavigationApiV1;
  readonly sidebar: ExtensionSidebarApiV1;
  readonly workbench: ExtensionWorkbenchApiV1;
  readonly themes: ExtensionThemesApiV1;
  readonly bots: ExtensionBotsApiV1;
}

export class ExtensionManifestError extends TypeError {
  readonly code = "OPENCRAFT_EXTENSION_MANIFEST_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ExtensionManifestError";
  }
}

const extensionIdPattern = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u;
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const platforms = new Set<ExtensionPlatform>(["web", "electron", "expo"]);

export function isExtensionId(value: string): boolean {
  return extensionIdPattern.test(value);
}

export function assertOwnedContributionId(extensionId: string, contributionId: string): void {
  if (contributionId !== extensionId && !contributionId.startsWith(`${extensionId}.`)) {
    throw new RangeError(
      `Contribution ${contributionId} must be namespaced by extension ${extensionId}`,
    );
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExtensionManifestError("Extension manifest must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExtensionManifestError(`Extension manifest requires ${key}`);
  }
  return value.trim();
}

function requireStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExtensionManifestError(`Extension manifest ${key} must be a non-empty array`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ExtensionManifestError(`Extension manifest ${key} contains an invalid value`);
    }
    return entry.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new ExtensionManifestError(`Extension manifest ${key} contains duplicates`);
  }
  return Object.freeze(normalized);
}

export function parseExtensionManifestV1(value: unknown): ExtensionManifestV1 {
  const record = requireRecord(value);
  if (record.manifestVersion !== 1) {
    throw new ExtensionManifestError("Only extension manifestVersion 1 is supported");
  }
  if (record.apiVersion !== 1) {
    throw new ExtensionManifestError("Only extension apiVersion 1 is supported");
  }
  if (record.trust !== "trusted") {
    throw new ExtensionManifestError("Trusted V1 extensions require trust=trusted");
  }
  const id = requireString(record, "id");
  if (!isExtensionId(id)) {
    throw new ExtensionManifestError(`Extension ID ${id} is not a reverse-domain identifier`);
  }
  const version = requireString(record, "version");
  if (!semanticVersionPattern.test(version)) {
    throw new ExtensionManifestError(`Extension ${id} has an invalid semantic version`);
  }
  const platformValues = requireStringArray(record, "platforms");
  for (const platform of platformValues) {
    if (!platforms.has(platform as ExtensionPlatform)) {
      throw new ExtensionManifestError(`Extension ${id} targets unknown platform ${platform}`);
    }
  }
  const activationEvents = requireStringArray(record, "activationEvents");
  for (const event of activationEvents) {
    if (
      event !== "*"
      && event !== "onStartupFinished"
      && !event.startsWith("onCommand:")
      && !event.startsWith("onView:")
    ) {
      throw new ExtensionManifestError(`Extension ${id} has invalid activation event ${event}`);
    }
  }
  const description = record.description;
  if (description !== undefined && typeof description !== "string") {
    throw new ExtensionManifestError(`Extension ${id} description must be a string`);
  }
  const dependencies = record.dependencies === undefined
    ? undefined
    : requireStringArray(record, "dependencies");
  for (const dependency of dependencies ?? []) {
    if (!isExtensionId(dependency)) {
      throw new ExtensionManifestError(`Extension ${id} has invalid dependency ${dependency}`);
    }
    if (dependency === id) {
      throw new ExtensionManifestError(`Extension ${id} cannot depend on itself`);
    }
  }
  return Object.freeze({
    manifestVersion: 1,
    id,
    name: requireString(record, "name"),
    version,
    apiVersion: 1,
    trust: "trusted",
    platforms: platformValues as readonly ExtensionPlatform[],
    activationEvents: activationEvents as readonly ExtensionActivationEvent[],
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(description === undefined ? {} : { description }),
  });
}
