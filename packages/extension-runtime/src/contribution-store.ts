import {
  assertOwnedContributionId,
  type BotContribution,
  type CommandContribution,
  type CommandHandler,
  type ExtensionActivationIdentity,
  type ExtensionJson,
  type NavigationContribution,
  type SettingsPageContribution,
  type SettingsSchemaContribution,
  type SidebarCatalogContribution,
  type ThemeContribution,
  type ViewContribution,
  type WorkbenchSurfaceContribution,
} from "@opencraft/extension-contract";

export interface OwnedContribution<T> {
  readonly owner: ExtensionActivationIdentity;
  readonly contribution: T;
}

export interface ExtensionContributionSnapshot {
  readonly revision: number;
  readonly commands: readonly OwnedContribution<CommandContribution>[];
  readonly settingsSchemas: readonly OwnedContribution<SettingsSchemaContribution>[];
  readonly views: readonly OwnedContribution<ViewContribution>[];
  readonly navigation: readonly OwnedContribution<NavigationContribution>[];
  readonly sidebarCatalogs: readonly OwnedContribution<SidebarCatalogContribution>[];
  readonly settingsPages: readonly OwnedContribution<SettingsPageContribution>[];
  readonly workbenchSurfaces: readonly OwnedContribution<WorkbenchSurfaceContribution>[];
  readonly themes: readonly OwnedContribution<ThemeContribution>[];
  readonly bots: readonly OwnedContribution<BotContribution>[];
}

export interface PublicContributionBatch {
  readonly commands: readonly {
    readonly contribution: CommandContribution;
    readonly handler: CommandHandler;
  }[];
  readonly settingsSchemas: readonly SettingsSchemaContribution[];
  readonly views: readonly ViewContribution[];
  readonly navigation: readonly NavigationContribution[];
  readonly sidebarCatalogs: readonly SidebarCatalogContribution[];
  readonly settingsPages: readonly SettingsPageContribution[];
  readonly workbenchSurfaces: readonly WorkbenchSurfaceContribution[];
  readonly themes: readonly ThemeContribution[];
  readonly bots: readonly BotContribution[];
}

interface CommandRecord extends OwnedContribution<CommandContribution> {
  readonly handler: CommandHandler;
}

function requireLabel(value: string, label: string): void {
  if (value.trim().length === 0) throw new RangeError(`${label} must not be empty`);
}

function validateCommand(owner: ExtensionActivationIdentity, value: CommandContribution): void {
  assertOwnedContributionId(owner.extensionId, value.id);
  requireLabel(value.title, `Command ${value.id} title`);
}

function validateSettingsSchema(owner: ExtensionActivationIdentity, value: SettingsSchemaContribution): void {
  assertOwnedContributionId(owner.extensionId, value.id);
  requireLabel(value.title, `Settings ${value.id} title`);
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw new RangeError(`Settings ${value.id} has an invalid schemaVersion`);
  }
  const keys = new Set<string>();
  for (const field of value.fields) {
    const fieldKey = field.key;
    const candidateDefault = (field as { readonly defaultValue?: unknown }).defaultValue;
    requireLabel(fieldKey, `Settings ${value.id} field key`);
    requireLabel(field.title, `Settings ${value.id}.${fieldKey} title`);
    if (keys.has(fieldKey)) throw new Error(`Settings ${value.id} contains duplicate field ${fieldKey}`);
    keys.add(fieldKey);
    if (field.type === "boolean" && typeof candidateDefault !== "boolean") {
      throw new TypeError(`Settings ${value.id}.${fieldKey} requires a boolean defaultValue`);
    }
    if (
      field.type === "number"
      && candidateDefault !== undefined
      && (typeof candidateDefault !== "number" || !Number.isFinite(candidateDefault))
    ) {
      throw new TypeError(`Settings ${value.id}.${fieldKey} has an invalid number defaultValue`);
    }
    if (
      field.type === "string"
      && candidateDefault !== undefined
      && typeof candidateDefault !== "string"
    ) {
      throw new TypeError(`Settings ${value.id}.${fieldKey} has an invalid string defaultValue`);
    }
    if (field.type === "select") {
      if (field.options.length === 0) throw new RangeError(`Settings ${value.id}.${field.key} has no options`);
      const options = new Set<string>();
      for (const option of field.options) {
        requireLabel(option.value, `Settings ${value.id}.${field.key} option value`);
        requireLabel(option.label, `Settings ${value.id}.${field.key} option label`);
        if (options.has(option.value)) {
          throw new Error(`Settings ${value.id}.${field.key} contains duplicate option ${option.value}`);
        }
        options.add(option.value);
      }
      if (
        candidateDefault !== undefined
        && !field.options.some((option) => option.value === candidateDefault)
      ) {
        throw new TypeError(
          `Settings ${value.id}.${fieldKey} defaultValue is not a declared option`,
        );
      }
    }
  }
}

function validateView(owner: ExtensionActivationIdentity, value: ViewContribution): void {
  assertOwnedContributionId(owner.extensionId, value.id);
  requireLabel(value.title, `View ${value.id} title`);
  requireLabel(value.viewType, `View ${value.id} viewType`);
  if (value.role !== undefined && value.role !== "bot-conversation") {
    throw new RangeError(`View ${value.id} has an invalid semantic role`);
  }
}

function validateNavigation(owner: ExtensionActivationIdentity, value: NavigationContribution): void {
  assertOwnedContributionId(owner.extensionId, value.id);
  requireLabel(value.title, `Navigation ${value.id} title`);
  if (!(["sidebar-primary", "sidebar-footer"] as const).includes(value.surface)) {
    throw new RangeError(`Navigation ${value.id} has an invalid surface`);
  }
  if (value.target.kind === "command") {
    assertOwnedContributionId(owner.extensionId, value.target.commandId);
  } else if (value.target.kind === "settings") {
    assertOwnedContributionId(owner.extensionId, value.target.pageId);
  } else if (value.target.kind === "view") {
    assertOwnedContributionId(owner.extensionId, value.target.viewId);
  } else {
    throw new RangeError(`Navigation ${value.id} has an invalid target`);
  }
}

function validateSidebarCatalog(owner: ExtensionActivationIdentity, value: SidebarCatalogContribution): void {
  assertOwnedContributionId(owner.extensionId, value.id);
  assertOwnedContributionId(owner.extensionId, value.viewId);
  requireLabel(value.title, `Sidebar catalog ${value.id} title`);
}

function validateSettingsPage(owner: ExtensionActivationIdentity, value: SettingsPageContribution): void {
  assertOwnedContributionId(owner.extensionId, value.id);
  assertOwnedContributionId(owner.extensionId, value.viewId);
  requireLabel(value.title, `Settings page ${value.id} title`);
  if (value.layout !== undefined && value.layout !== "document" && value.layout !== "master-detail") throw new RangeError("Invalid settings page layout");
  if (value.management !== undefined) {
    assertOwnedContributionId(owner.extensionId, value.management.familyId);
    if (value.management.scope !== "agent" && value.management.scope !== "host") {
      throw new RangeError(`Settings page ${value.id} has an invalid management scope`);
    }
  }
}

function validateWorkbenchSurface(owner: ExtensionActivationIdentity, value: WorkbenchSurfaceContribution): void {
  // Contributions can originate in dynamically loaded JavaScript; validate a
  // structural view even though trusted TypeScript callers receive the tighter
  // discriminated union.
  const candidate = value as {
    readonly id: string;
    readonly viewId: string;
    readonly surface: string;
    readonly providerId?: string;
    readonly intervention?: string;
  };
  assertOwnedContributionId(owner.extensionId, candidate.id);
  assertOwnedContributionId(owner.extensionId, candidate.viewId);
  if (candidate.surface !== "empty-workbench" && candidate.surface !== "host-connection-intervention") {
    throw new RangeError(`Workbench surface ${candidate.id} has an invalid surface`);
  }
  if (candidate.surface === "host-connection-intervention") {
    if (candidate.providerId === undefined) {
      throw new RangeError(`Workbench surface ${candidate.id} requires a provider ID`);
    }
    assertOwnedContributionId(owner.extensionId, candidate.providerId);
    if (candidate.intervention !== "authentication-required" && candidate.intervention !== "configuration-required") {
      throw new RangeError(`Workbench surface ${candidate.id} has an invalid intervention`);
    }
  } else if (candidate.providerId !== undefined || candidate.intervention !== undefined) {
    throw new RangeError(`Workbench surface ${candidate.id} cannot target a provider intervention`);
  }
}

const colorPattern = /^#[0-9a-f]{6}$/iu;

function validateTheme(owner: ExtensionActivationIdentity, value: ThemeContribution): void {
  assertOwnedContributionId(owner.extensionId, value.id);
  requireLabel(value.label, `Theme ${value.id} label`);
  for (const [mode, palette] of Object.entries(value.palettes)) {
    if (!Number.isFinite(palette.contrast) || palette.contrast < 0 || palette.contrast > 100) {
      throw new RangeError(`Theme ${value.id} ${mode} contrast must be between 0 and 100`);
    }
    for (const [name, color] of Object.entries({
      accent: palette.accent,
      ink: palette.ink,
      surface: palette.surface,
      ...palette.semanticColors,
    })) {
      if (!colorPattern.test(color)) {
        throw new RangeError(`Theme ${value.id} ${mode}.${name} must be a #RRGGBB color`);
      }
    }
  }
}

function validateBot(owner: ExtensionActivationIdentity, value: BotContribution): void {
  assertOwnedContributionId(owner.extensionId, value.id);
  requireLabel(value.name, `Bot ${value.id} name`);
  if (value.subtitle !== undefined) requireLabel(value.subtitle, `Bot ${value.id} subtitle`);
  if (value.avatar.kind === "image-url") {
    requireLabel(value.avatar.url, `Bot ${value.id} avatar URL`);
    try {
      const protocol = new URL(value.avatar.url, "https://vela.invalid").protocol;
      if (!["https:", "http:", "data:"].includes(protocol)) throw new Error();
    } catch {
      throw new RangeError(`Bot ${value.id} has an invalid avatar URL`);
    }
  } else if (value.avatar.kind === "monogram") {
    requireLabel(value.avatar.text, `Bot ${value.id} avatar text`);
    if (value.avatar.text.length > 3) throw new RangeError(`Bot ${value.id} avatar text is too long`);
    if (!colorPattern.test(value.avatar.background)) {
      throw new RangeError(`Bot ${value.id} avatar background must be a #RRGGBB color`);
    }
    if (value.avatar.foreground !== undefined && !colorPattern.test(value.avatar.foreground)) {
      throw new RangeError(`Bot ${value.id} avatar foreground must be a #RRGGBB color`);
    }
  } else if (value.avatar.kind === "generated") {
    requireLabel(value.avatar.seed, `Bot ${value.id} avatar seed`);
    if (value.avatar.palette !== undefined) {
      requireLabel(value.avatar.palette, `Bot ${value.id} avatar palette`);
    }
  } else {
    requireLabel(value.avatar.uri, `Bot ${value.id} avatar resource URI`);
  }
  if (
    value.availability !== undefined
    && !["available", "connecting", "unavailable", "disabled"].includes(value.availability)
  ) throw new RangeError(`Bot ${value.id} has an invalid availability`);
  if (value.action.kind === "command") {
    requireLabel(value.action.commandId, `Bot ${value.id} command`);
  } else if (value.action.kind === "view") {
    requireLabel(value.action.viewId, `Bot ${value.id} View ID`);
    if (value.action.resourceUri !== undefined)
      requireLabel(value.action.resourceUri, `Bot ${value.id} View resource URI`);
  } else {
    try {
      const protocol = new URL(value.action.url).protocol;
      if (protocol !== "https:" && protocol !== "http:") throw new Error();
    } catch {
      throw new RangeError(`Bot ${value.id} has an invalid external URL`);
    }
  }
}

function freezeCommand(value: CommandContribution): CommandContribution {
  return Object.freeze({ ...value });
}

function freezeSettingsSchema(value: SettingsSchemaContribution): SettingsSchemaContribution {
  return Object.freeze({
    ...value,
    fields: Object.freeze(value.fields.map((field) => Object.freeze({
      ...field,
      ...(field.type === "select"
        ? { options: Object.freeze(field.options.map((option) => Object.freeze({ ...option }))) }
        : {}),
    }))),
  });
}

function freezeView(value: ViewContribution): ViewContribution {
  return Object.freeze({
    ...value,
    ...(value.platforms === undefined ? {} : { platforms: Object.freeze([...value.platforms]) }),
  });
}

function freezePlatforms<T extends { readonly platforms?: readonly string[] }>(value: T): T {
  return Object.freeze({
    ...value,
    ...(value.platforms === undefined ? {} : { platforms: Object.freeze([...value.platforms]) }),
  });
}

function freezeNavigation(value: NavigationContribution): NavigationContribution {
  return Object.freeze({
    ...value,
    target: Object.freeze({ ...value.target }),
    ...(value.platforms === undefined ? {} : { platforms: Object.freeze([...value.platforms]) }),
  });
}

function freezeTheme(value: ThemeContribution): ThemeContribution {
  const freezePalette = (palette: ThemeContribution["palettes"]["light"]) => Object.freeze({
    ...palette,
    semanticColors: Object.freeze({ ...palette.semanticColors }),
  });
  return Object.freeze({
    ...value,
    palettes: Object.freeze({
      light: freezePalette(value.palettes.light),
      dark: freezePalette(value.palettes.dark),
    }),
  });
}

function freezeBot(value: BotContribution): BotContribution {
  return Object.freeze({
    ...value,
    avatar: Object.freeze({ ...value.avatar }),
    action: Object.freeze({ ...value.action }),
    ...(value.platforms === undefined ? {} : { platforms: Object.freeze([...value.platforms]) }),
  });
}

function freezeSettingsPage(value: SettingsPageContribution): SettingsPageContribution {
  return Object.freeze({
    ...value,
    ...(value.management === undefined
      ? {}
      : { management: Object.freeze({ ...value.management }) }),
    ...(value.platforms === undefined
      ? {}
      : { platforms: Object.freeze([...value.platforms]) }),
  });
}

/**
 * Canonical registry for the stable V1 contribution surface. A complete
 * activation batch is validated first and then published in one snapshot.
 */
export class ExtensionContributionStore {
  private readonly commands = new Map<string, CommandRecord>();
  private readonly settingsSchemas = new Map<string, OwnedContribution<SettingsSchemaContribution>>();
  private readonly views = new Map<string, OwnedContribution<ViewContribution>>();
  private readonly navigation = new Map<string, OwnedContribution<NavigationContribution>>();
  private readonly sidebarCatalogs = new Map<string, OwnedContribution<SidebarCatalogContribution>>();
  private readonly settingsPages = new Map<string, OwnedContribution<SettingsPageContribution>>();
  private readonly workbenchSurfaces = new Map<string, OwnedContribution<WorkbenchSurfaceContribution>>();
  private readonly themes = new Map<string, OwnedContribution<ThemeContribution>>();
  private readonly bots = new Map<string, OwnedContribution<BotContribution>>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private closed = false;
  private snapshot: ExtensionContributionSnapshot = {
    revision: 0,
    commands: [],
    settingsSchemas: [],
    views: [],
    navigation: [],
    sidebarCatalogs: [],
    settingsPages: [],
    workbenchSurfaces: [],
    themes: [],
    bots: [],
  };

  getSnapshot = (): ExtensionContributionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  prepare(owner: ExtensionActivationIdentity, batch: PublicContributionBatch): () => void {
    this.ensureOpen();
    const allIds = new Set<string>();
    for (const entry of batch.commands) {
      validateCommand(owner, entry.contribution);
      this.assertAvailable(entry.contribution.id, this.commands, allIds);
    }
    for (const contribution of batch.settingsSchemas) {
      validateSettingsSchema(owner, contribution);
      this.assertAvailable(contribution.id, this.settingsSchemas, allIds);
    }
    for (const contribution of batch.views) {
      validateView(owner, contribution);
      this.assertAvailable(contribution.id, this.views, allIds);
    }
    this.assertViewRolesAvailable(batch.views);
    for (const contribution of batch.navigation) {
      validateNavigation(owner, contribution);
      this.assertAvailable(contribution.id, this.navigation, allIds);
    }
    for (const contribution of batch.sidebarCatalogs) {
      validateSidebarCatalog(owner, contribution);
      this.assertAvailable(contribution.id, this.sidebarCatalogs, allIds);
    }
    for (const contribution of batch.settingsPages) {
      validateSettingsPage(owner, contribution);
      this.assertAvailable(contribution.id, this.settingsPages, allIds);
    }
    for (const contribution of batch.workbenchSurfaces) {
      validateWorkbenchSurface(owner, contribution);
      this.assertAvailable(contribution.id, this.workbenchSurfaces, allIds);
    }
    for (const contribution of batch.themes) {
      validateTheme(owner, contribution);
      this.assertAvailable(contribution.id, this.themes, allIds);
    }
    for (const contribution of batch.bots) {
      validateBot(owner, contribution);
      this.assertAvailable(contribution.id, this.bots, allIds);
    }

    const hasView = (id: string) => this.views.has(id) || batch.views.some((view) => view.id === id);
    const hasCommand = (id: string) => this.commands.has(id) || batch.commands.some((entry) => entry.contribution.id === id);
    const hasSettingsPage = (id: string) => this.settingsPages.has(id) || batch.settingsPages.some((page) => page.id === id);
    for (const contribution of batch.navigation) {
      const targetExists = contribution.target.kind === "command"
        ? hasCommand(contribution.target.commandId)
        : contribution.target.kind === "settings"
          ? hasSettingsPage(contribution.target.pageId)
          : hasView(contribution.target.viewId);
      if (!targetExists) throw new Error(`Navigation ${contribution.id} targets an unregistered contribution`);
    }
    for (const contribution of batch.bots) {
      if (contribution.action.kind === "command" && !hasCommand(contribution.action.commandId)) {
        throw new Error(`Bot ${contribution.id} targets an unregistered command`);
      }
    }
    for (const contribution of [
      ...batch.sidebarCatalogs,
      ...batch.settingsPages,
      ...batch.workbenchSurfaces,
    ]) {
      if (!hasView(contribution.viewId)) {
        throw new Error(`Contribution ${contribution.id} targets unregistered View ${contribution.viewId}`);
      }
    }

    let committed = false;
    return () => {
      if (committed) throw new Error(`Contributions for ${owner.activationId} were already committed`);
      committed = true;
      // JavaScript execution is single-threaded. Recheck immediately before
      // mutation so a nested activation cannot invalidate the prepared batch.
      for (const id of allIds) {
        if (this.hasAny(id)) {
          throw new Error(`Contribution ${id} was registered while activation was preparing`);
        }
      }
      this.assertViewRolesAvailable(batch.views);
      for (const entry of batch.commands) {
        this.commands.set(entry.contribution.id, {
          owner,
          contribution: freezeCommand(entry.contribution),
          handler: entry.handler,
        });
      }
      for (const contribution of batch.settingsSchemas) {
        this.settingsSchemas.set(contribution.id, {
          owner,
          contribution: freezeSettingsSchema(contribution),
        });
      }
      for (const contribution of batch.views) {
        this.views.set(contribution.id, {
          owner,
          contribution: freezeView(contribution),
        });
      }
      for (const contribution of batch.navigation) {
        this.navigation.set(contribution.id, { owner, contribution: freezeNavigation(contribution) });
      }
      for (const contribution of batch.sidebarCatalogs) {
        this.sidebarCatalogs.set(contribution.id, { owner, contribution: freezePlatforms(contribution) });
      }
      for (const contribution of batch.settingsPages) {
        this.settingsPages.set(contribution.id, { owner, contribution: freezeSettingsPage(contribution) });
      }
      for (const contribution of batch.workbenchSurfaces) {
        this.workbenchSurfaces.set(contribution.id, { owner, contribution: freezePlatforms(contribution) });
      }
      for (const contribution of batch.themes) {
        this.themes.set(contribution.id, {
          owner,
          contribution: freezeTheme(contribution),
        });
      }
      for (const contribution of batch.bots) {
        this.bots.set(contribution.id, { owner, contribution: freezeBot(contribution) });
      }
      this.publish();
    };
  }

  remove(
    owner: ExtensionActivationIdentity,
    kind: "command" | "settings-schema" | "view" | "navigation" | "sidebar-catalog" | "settings-page" | "workbench-surface" | "theme" | "bot",
    id: string,
  ): void {
    if (this.closed) return;
    const records = kind === "command"
      ? this.commands
      : kind === "settings-schema"
        ? this.settingsSchemas
        : kind === "view"
          ? this.views
          : kind === "navigation"
            ? this.navigation
            : kind === "sidebar-catalog"
              ? this.sidebarCatalogs
              : kind === "settings-page"
                ? this.settingsPages
                : kind === "workbench-surface"
                  ? this.workbenchSurfaces
                  : kind === "theme"
                    ? this.themes
                    : this.bots;
    const record = records.get(id) as OwnedContribution<unknown> | undefined;
    if (record?.owner.activationId !== owner.activationId) return;
    records.delete(id);
    if (kind === "view") {
      for (const [dependentId, dependent] of this.sidebarCatalogs) {
        if (dependent.contribution.viewId === id) this.sidebarCatalogs.delete(dependentId);
      }
      for (const [dependentId, dependent] of this.settingsPages) {
        if (dependent.contribution.viewId === id) {
          this.settingsPages.delete(dependentId);
          this.removeNavigationTarget("settings", dependentId);
        }
      }
      for (const [dependentId, dependent] of this.workbenchSurfaces) {
        if (dependent.contribution.viewId === id) this.workbenchSurfaces.delete(dependentId);
      }
      this.removeNavigationTarget("view", id);
    } else if (kind === "command") {
      this.removeNavigationTarget("command", id);
    } else if (kind === "settings-page") {
      this.removeNavigationTarget("settings", id);
    }
    this.publish();
  }

  removeOwner(owner: ExtensionActivationIdentity): void {
    if (this.closed) return;
    let changed = false;
    for (const records of [
      this.commands,
      this.settingsSchemas,
      this.views,
      this.navigation,
      this.sidebarCatalogs,
      this.settingsPages,
      this.workbenchSurfaces,
      this.themes,
      this.bots,
    ]) {
      for (const [id, record] of records) {
        if (record.owner.activationId !== owner.activationId) continue;
        records.delete(id);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  async executeCommand(id: string, ...arguments_: readonly ExtensionJson[]): Promise<ExtensionJson | void> {
    this.ensureOpen();
    const record = this.commands.get(id);
    if (record === undefined) throw new Error(`Command ${id} is not registered`);
    return record.handler(...arguments_);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.commands.clear();
    this.settingsSchemas.clear();
    this.views.clear();
    this.navigation.clear();
    this.sidebarCatalogs.clear();
    this.settingsPages.clear();
    this.workbenchSurfaces.clear();
    this.themes.clear();
    this.bots.clear();
    this.publish();
    this.listeners.clear();
  }

  private assertAvailable<T>(id: string, records: Map<string, T>, batchIds: Set<string>): void {
    if (records.has(id) || batchIds.has(id)) throw new Error(`Contribution ${id} is already registered`);
    if (this.hasAny(id)) {
      throw new Error(`Contribution ${id} is already registered in another contribution domain`);
    }
    batchIds.add(id);
  }

  private assertViewRolesAvailable(views: readonly ViewContribution[]): void {
    const claimed = new Map<string, string>();
    for (const record of this.views.values()) {
      const role = record.contribution.role;
      if (role !== undefined) claimed.set(role, record.contribution.id);
    }
    for (const view of views) {
      const role = view.role;
      if (role === undefined) continue;
      const existing = claimed.get(role);
      if (existing !== undefined) {
        throw new Error(`View role ${role} is already owned by ${existing}`);
      }
      claimed.set(role, view.id);
    }
  }

  private hasAny(id: string): boolean {
    return this.commands.has(id)
      || this.settingsSchemas.has(id)
      || this.views.has(id)
      || this.navigation.has(id)
      || this.sidebarCatalogs.has(id)
      || this.settingsPages.has(id)
      || this.workbenchSurfaces.has(id)
      || this.themes.has(id)
      || this.bots.has(id);
  }

  private removeNavigationTarget(kind: "command" | "settings" | "view", id: string): void {
    for (const [navigationId, record] of this.navigation) {
      const target = record.contribution.target;
      if (target.kind === kind) {
        const targetId = kind === "command"
          ? (target as { readonly commandId: string }).commandId
          : kind === "settings"
            ? (target as { readonly pageId: string }).pageId
            : (target as { readonly viewId: string }).viewId;
        if (targetId === id) this.navigation.delete(navigationId);
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Extension contribution store is closed");
  }

  private publish(): void {
    this.revision += 1;
    this.snapshot = Object.freeze({
      revision: this.revision,
      commands: Object.freeze([...this.commands.values()].map(({ owner, contribution }) => ({ owner, contribution }))),
      settingsSchemas: Object.freeze([...this.settingsSchemas.values()]),
      views: Object.freeze([...this.views.values()]),
      navigation: Object.freeze([...this.navigation.values()]),
      sidebarCatalogs: Object.freeze([...this.sidebarCatalogs.values()]),
      settingsPages: Object.freeze([...this.settingsPages.values()]),
      workbenchSurfaces: Object.freeze([...this.workbenchSurfaces.values()]),
      themes: Object.freeze([...this.themes.values()]),
      bots: Object.freeze([...this.bots.values()]),
    });
    if (this.closed) return;
    for (const listener of this.listeners) listener();
  }
}
