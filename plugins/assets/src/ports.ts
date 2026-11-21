import type { ComponentType, ReactNode } from "react";
import type { AssetProvider } from "./providers";

/** Opaque verified account scope supplied by the existing identity owner.
 * A scope is a stale-response fence, not authorization or a client-selected user. */
export interface AssetsAccount {
  subscribe(listener: () => void): () => void;
  getScope(): string | null;
  refresh(): void | Promise<void>;
}
/** Read-only projection and provider-owned editor; raw credentials never enter the catalog. */
export interface AssetConnections {
  readonly available: boolean;
  readonly busy: boolean;
  readonly unauthorized: boolean;
  readonly readError?: string;
  configured(host: string): boolean;
  description(host: string): string;
  load(): void | Promise<void>;
  renderEditor(host: string, onDraftChange: (dirty: boolean) => void): ReactNode;
}
export interface AssetVariablesProps {
  readonly scope: string;
  readonly onStateChange: (state: { dirty: boolean; writing: boolean }) => void;
}
export interface AssetsViewOptions {
  readonly account: AssetsAccount;
  /** Authenticated transport; the server independently derives identity and permissions. */
  readonly fetcher: typeof fetch;
  readonly endpoint: string;
  readonly providers: readonly AssetProvider[];
  /** Fixed trusted hook for this factory's lifetime; not mutable plugin discovery. */
  readonly useConnections?: (scope: string, onUnauthorized: () => void) => AssetConnections;
  readonly VariablesEditor?: ComponentType<AssetVariablesProps>;
  readonly initialVariables?: boolean;
  readonly variablesTitleMessage?: { readonly id: string; readonly defaultMessage: string };
  readonly assistantViewId?: string;
}
export const noAssetConnections: AssetConnections = Object.freeze({
  available: false,
  busy: false,
  unauthorized: false,
  configured: () => false,
  description: () => "",
  load() {},
  renderEditor: () => null,
});
