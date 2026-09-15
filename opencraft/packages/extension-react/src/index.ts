import type { ComponentType } from "react";

import type { ViewContribution } from "@opencraft/extension-contract";
import type { HostConnectionProfile, ProvisionHostInput } from "@opencraft/workbench-runtime";

export * from "./composer-actions";
export * from "./settings-controls";
export * from "./settings-panel";
export * from "./adaptive-panel";
export * from "./settings-search-select";

export type { ProvisionHostInput } from "@opencraft/workbench-runtime";

/** Host-owned operations exposed to a trusted platform View. */
export interface PlatformViewHost {
  readonly authentication?: AuthenticationFlowPort;
  readonly platform: "web" | "electron" | "expo";
  readonly activeHostId: string;
  readonly profiles: readonly HostConnectionProfile[];
  provisionHost(input: ProvisionHostInput): Promise<HostConnectionProfile>;
  removeHost(hostId: string): Promise<boolean>;
  openView(viewId: string, resourceUri?: string | null): void;
  openSettings?(section: string): void;
  /** Pushes a new deep-link entry for another resource owned by the active View. */
  pushViewResource(viewId: string, resourceUri: string): void;
  replaceViewResource(viewId: string, resourceUri: string): void;
  /** Host-owned image pipeline shared by chat attachments and trusted Views. */
  prepareImageUpload?(blob: Blob): Promise<Blob>;
}

/** @deprecated Use the location-neutral PlatformViewHost name. */
export type ExtensionSettingsViewHost = PlatformViewHost;

export interface ExtensionSettingsViewProps {
  /** Only the dedicated sign-in presentation receives a pre-existing flow lease. */
  readonly authenticationFlowId?: string;
  /** Present only when this View is hosted in a dismissible utility window. */
  readonly onDismiss?: () => void;
  readonly contribution: ViewContribution;
  readonly host: PlatformViewHost;
  readonly activation: {
    readonly viewId: string;
    readonly resourceUri: string | null;
  };
}

export interface PlatformViewRendererContribution {
  readonly viewType: string;
  readonly Component: ComponentType<ExtensionSettingsViewProps>;
}

export interface PlatformAccountSnapshot {
  readonly revision: number;
  readonly phase: "anonymous" | "loading" | "authenticated" | "error";
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly planLabel: string | null;
  readonly usageRemainingPercent: number | null;
  readonly error: string | null;
  readonly environmentRequests?: readonly { readonly id: string; readonly name: string; readonly status: string }[];
  /**
   * @deprecated Web/Electron ignore account-level gates. Only an actual
   * selected-Host connection failure can request an intervention surface.
   * Retained for source compatibility with older account contributions.
   */
  readonly applicationIntervention?: {
    readonly providerId: string;
    readonly code: "authentication-required" | "configuration-required";
  } | null;
}

/**
 * Trusted product adapter for an account authority. The shell owns only the
 * menu/modal chrome; authentication, refresh and account content remain owned
 * by the contributing product extension.
 */
export interface PlatformAccountContribution {
  readonly signInOptions?: readonly { readonly id: string; readonly label: string; readonly description: string }[];
  readonly authenticationProviderId?: string;
  readonly signInViewId?: string;
  readonly id: string;
  readonly viewId: string;
  /** Optional, provider-owned environment creation View; Shell owns only presentation. */
  readonly environmentCreation?: {
    readonly label: string;
    readonly viewId: string;
  };
  getSnapshot(): PlatformAccountSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<unknown>;
  signOut(): Promise<void>;
}

export interface OwnedPlatformViewRenderer extends PlatformViewRendererContribution {
  readonly ownerId: string;
}

export interface PlatformViewRendererSnapshot {
  readonly revision: number;
  readonly renderers: readonly OwnedPlatformViewRenderer[];
}

/** Framework-specific renderer registry; stable extension contracts stay JSX-free. */
export class PlatformViewRendererRegistry {
  private readonly records = new Map<string, OwnedPlatformViewRenderer>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private snapshot: PlatformViewRendererSnapshot = Object.freeze({ revision: 0, renderers: [] });

  getSnapshot = (): PlatformViewRendererSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  register(ownerId: string, contribution: PlatformViewRendererContribution): () => void {
    const viewType = contribution.viewType.trim();
    if (!viewType) throw new RangeError("Platform View renderer requires viewType");
    if (this.records.has(viewType)) throw new Error(`Platform View renderer ${viewType} is already registered`);
    const record = Object.freeze({ ownerId, viewType, Component: contribution.Component });
    this.records.set(viewType, record);
    this.publish();
    return () => {
      if (this.records.get(viewType) !== record) return;
      this.records.delete(viewType);
      this.publish();
    };
  }

  resolve(viewType: string): ComponentType<ExtensionSettingsViewProps> | null {
    return this.records.get(viewType)?.Component ?? null;
  }

  private publish(): void {
    this.snapshot = Object.freeze({
      revision: ++this.revision,
      renderers: Object.freeze([...this.records.values()]),
    });
    for (const listener of this.listeners) listener();
  }
}
import type { AuthenticationFlowPort } from "@opencraft/workbench-runtime";
