import hostPanelLayoutStyles from "./host-panel-layout.css?inline";
import { EmbeddedHostPanelLayout } from "./host-panel-layout";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import appStyles from "../styles/app.scss?inline";
import proseStyles from "../../../../packages/chat-render-web/src/renderers/prose/prose.scss?inline";
import codeStyles from "../../../../packages/chat-render-web/src/renderers/code/code-block.scss?inline";
import imageStyles from "../../../../packages/chat-render-web/src/renderers/media/image.scss?inline";
import resourceStyles from "../../../../packages/chat-render-web/src/renderers/resource-link/resource-link.scss?inline";
import tableStyles from "../../../../packages/chat-render-web/src/renderers/table/table.scss?inline";
import katexStyles from "katex/dist/katex.min.css?inline";
import katexOverrides from "../../../../packages/chat-render-web/src/extensions/katex/katex.scss?inline";
import mermaidStyles from "../../../../packages/chat-render-web/src/extensions/mermaid/mermaid.scss?inline";
import xtermStyles from "@xterm/xterm/css/xterm.css?inline";

import type {
  EmbeddedWorkbenchAppActions,
  EmbeddedWorkbenchAppSession,
} from "../app";
import type { UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { embeddedLocaleCatalogs } from "../i18n/catalogs";
import { WorkbenchLocaleController, WorkbenchIntlProvider, validateWorkbenchLocaleOptions, type WorkbenchLocaleOptions } from "../i18n/workbench-locale";
import {
  applyAppearanceThemeToElement,
  getAppearanceThemeSnapshot,
  subscribeToAppearanceTheme,
} from "../appearance-theme";

import {
  openWorkbenchUiPreferences,
  UiPreferencesProvider,
} from "../runtime/ui-preferences-runtime";
import {
  createEmbeddedChatApplication,
  type EmbeddedChatApplication,
  type EmbeddedChatApplicationOptions,
} from "./embedded-chat-application";
import {
  EmbeddedChatRoot,
} from "./embedded-chat-root";

import { observeEmbeddedConnection } from "./embedded-connection";
import { observeEmbeddedTurnCompletions, type EmbeddedWorkbenchTurnCompletedDetail } from "./embedded-turn-completion";
import { HermesPhysicalConnectionPreparation, type HermesPhysicalConnectionPreparationOptions } from "@opencraft/plugin-lightvela-hermes/physical-connection";
import { isHostPanelCommand, isHostPanelGeometry, isHostPanelGesture, type HostPanelGesture, type HostPanelCommand, type HostPanelGeometry, type HostPanelState } from "@opencraft/workbench-panels";

const ELEMENT_NAME = "opencraft-embedded-workbench";

export interface EmbeddedWorkbenchConfig extends EmbeddedChatApplicationOptions {
  /** Legacy name: host allocates the container; the complete DOM toolbar stays. */
  readonly externalPanelChrome?: boolean;
  readonly localization?: WorkbenchLocaleOptions;
}

export interface EmbeddedWorkbenchReadyDetail {
  readonly threadId: string | null;
  readonly hostId: string;
  readonly instanceId: string;
  readonly profileId: string;
}

export interface EmbeddedWorkbenchSession extends EmbeddedWorkbenchAppSession {}

export interface EmbeddedWorkbenchSessionsDetail {
  readonly sessions: readonly EmbeddedWorkbenchSession[];
  readonly loading: boolean;
  readonly hasMoreSessions: boolean;
  readonly pinSupported: boolean;
  readonly error: string | null;
  readonly selectedChatId: string | null;
  readonly isDraft: boolean;
}

function embeddedStyles(): string {
  const assetBase = (
    globalThis as typeof globalThis & { __OPENCRAFT_EMBED_ASSET_BASE__?: string }
  ).__OPENCRAFT_EMBED_ASSET_BASE__ ?? new URL("/", import.meta.url).href;
  const localizeAssets = (css: string) => css.replaceAll(
    "url(/assets/",
    `url(${assetBase}assets/`,
  );
  const application = localizeAssets(appStyles.replaceAll(":root", ":host"));
  return `
    :host {
      position: relative;
      display: block;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      color-scheme: light dark;
      contain: layout paint style;
      visibility: hidden;
      pointer-events: none;
    }
    :host([data-visible="true"]) { visibility: visible; pointer-events: auto; }
    .opencraft-embedded-workbench-root { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
    .opencraft-host-panel-overlays { position: absolute; inset: 0; pointer-events: none; }
    .opencraft-host-panel-overlays > * { pointer-events: auto; }
    ${application}
    ${hostPanelLayoutStyles}
    .opencraft-embedded-workbench-root { --height-toolbar: var(--lightvela-console-header-height, 46px); }
    .opencraft-embedded-workbench-root .codex-composer-queue-item__actions button.is-steer {
      width: 22px;
      padding: 0;
      gap: 0;
    }
    .opencraft-embedded-workbench-root .codex-composer-queue-item__actions button.is-steer > span { display: none; }
    .opencraft-embedded-workbench-root:has(.new-thread-draft-page) .main-content-viewport { --app-shell-main-content-frame-top-offset: 0px; }
    .opencraft-embedded-workbench-root:has(.new-thread-draft-page) .main-content-frame { border-top: 0; }
    .opencraft-embedded-workbench-root .main-content-surface { box-shadow: none; }
    .opencraft-embedded-workbench-root .codex-composer-voice-footer__status-label { display: none; }
    .opencraft-embedded-workbench-root .codex-composer-submit.is-stop {
      border-radius: 50%;
      background: transparent;
      color: var(--color-icon-primary);
    }
    .opencraft-embedded-workbench-root .codex-composer-submit.is-stop > svg {
      width: 24px;
      height: 24px;
      stroke-width: 2.25;
    }
    ${localizeAssets(proseStyles)}
    ${localizeAssets(codeStyles)}
    ${localizeAssets(imageStyles)}
    ${localizeAssets(resourceStyles)}
    ${localizeAssets(tableStyles)}
    ${localizeAssets(katexStyles)}
    ${localizeAssets(katexOverrides)}
    ${localizeAssets(mermaidStyles)}
    ${localizeAssets(xtermStyles)}
  `;
}

class EmbeddedWorkbenchErrorBoundary extends Component<{
  readonly children: ReactNode;
  readonly onError: (error: Error) => void;
}, { readonly error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return <div role="alert">OpenCraft Chat could not start.</div>;
  }
}

export class OpenCraftEmbeddedWorkbenchElement extends HTMLElement {
  /** Does not construct an element, Application, Dashboard or logical Host. */
  static preparePhysicalConnection(options: HermesPhysicalConnectionPreparationOptions): HermesPhysicalConnectionPreparation {
    return new HermesPhysicalConnectionPreparation(options);
  }
  private readonly mount: HTMLDivElement;
  private readonly panelMount: HTMLDivElement;
  private readonly overlayMount: HTMLDivElement;
  private panelState: HostPanelState | null = null;
  private readonly paneLayout: EmbeddedHostPanelLayout;
  private panelCommand: ((command: HostPanelCommand) => boolean) | null = null;
  private readonly root: Root;
  private actions: EmbeddedWorkbenchAppActions | null = null;
  private readonly admittedPrompts = new Set<string>();
  private application: EmbeddedChatApplication | null = null;
  private config: EmbeddedWorkbenchConfig | null = null;
  private preferences: UiPreferencesRuntime | null = null;
  private locale: WorkbenchLocaleController | null = null;
  private localeObserver: MutationObserver | null = null;
  private connection: ReturnType<typeof observeEmbeddedConnection> | null = null;
  private preparePromise: Promise<void> | null = null;
  private readyPromise: Promise<EmbeddedWorkbenchReadyDetail>;
  private resolveReady!: (detail: EmbeddedWorkbenchReadyDetail) => void;
  private rejectReady!: (error: Error) => void;
  private readyDetail: EmbeddedWorkbenchReadyDetail | null = null;
  /** Local Draft identity is painted before the Host connects; it never admits a submission. */
  private paintedPromise: Promise<void>;
  private resolvePainted!: () => void;
  private rejectPainted!: (error: Error) => void;
  private painted = false;
  private selectedConversationId: string | null = null;
  private isDraft = true;
  private hasMoreSessions = false;
  private sessions = new Map<string, EmbeddedWorkbenchSession>();
  private pinSupported = false;
  private stopThemeSubscription: (() => void) | null = null;
  private stopTurnCompletionSubscription: (() => void) | null = null;
  private disposed = false;
  private failed = false;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = embeddedStyles();
    this.mount = document.createElement("div");
    this.mount.className = "opencraft-embedded-workbench-root opencraft-host-chat-content";
    this.panelMount = document.createElement("div");
    this.panelMount.className = "opencraft-embedded-workbench-root opencraft-host-panel-content";

    this.overlayMount = document.createElement("div");
    this.overlayMount.className = "opencraft-embedded-workbench-root opencraft-host-panel-overlays";
    this.paneLayout = new EmbeddedHostPanelLayout(this.mount, this.panelMount, command => this.dispatchPanelCommand(command));
    this.paneLayout.subscribe(() => {
      if (this.disposed || !this.panelState) return;
      this.dispatchEvent(new CustomEvent("opencraft-panel-presentation", { bubbles: true, composed: true,
        detail: { ownerId: this.panelState.ownerId, active: this.paneLayout.getSnapshot() } }));
    });
    shadow.append(style, this.paneLayout.plane, this.overlayMount);
    this.root = createRoot(this.mount);
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.paintedPromise = new Promise((resolve, reject) => {
      this.resolvePainted = resolve;
      this.rejectPainted = reject;
    });
    void this.paintedPromise.catch(() => undefined);
    // Startup can fail or be disposed before prepareOwned begins awaiting readiness.
    // Observe rejection now; prepare()/show() still receive the original failure.
    void this.readyPromise.catch(() => undefined);
  }

  connectedCallback(): void {
    if (this.dataset.visible !== "true") this.dataset.visible = "false";
    this.inert = this.dataset.visible !== "true";
    this.syncTheme();
    this.stopThemeSubscription ??= subscribeToAppearanceTheme(() => this.syncTheme());
  }

  disconnectedCallback(): void {
    queueMicrotask(() => {
      if (!this.isConnected) void this.dispose();
    });
  }

  configure(config: EmbeddedWorkbenchConfig): void {
    if (this.preparePromise !== null) {
      throw new Error("Embedded Workbench cannot be reconfigured after preparation starts");
    }
    this.config = Object.freeze({ ...config, localization: validateWorkbenchLocaleOptions(config.localization ?? {}) });
  }

  prepare(): Promise<void> {
    if (this.preparePromise !== null) return this.preparePromise;
    if (this.disposed) return Promise.reject(new Error("Embedded Workbench is disposed"));
    const config = this.config;
    if (config === null) return Promise.reject(new Error("Embedded Workbench is not configured"));
    this.preparePromise = this.prepareOwned(config);
    return this.preparePromise;
  }

  dispatchPanelCommand(command: HostPanelCommand): boolean {
    if (this.disposed || !this.config?.externalPanelChrome || !isHostPanelCommand(command)
      || command.ownerId !== this.panelState?.ownerId) return false;
    return this.panelCommand?.(command) ?? false;
  }

  setPanelGeometry(ownerId: string, geometry: HostPanelGeometry): boolean {
    if (this.disposed || !this.config?.externalPanelChrome || ownerId !== this.panelState?.ownerId || !isHostPanelGeometry(geometry)) return false;
    this.paneLayout.setGeometry(geometry);
    return true;
  }

  dispatchPanelGesture(ownerId: string, gesture: HostPanelGesture): boolean {
    if (this.disposed || !this.config?.externalPanelChrome || ownerId !== this.panelState?.ownerId || !isHostPanelGesture(gesture)) return false;
    return this.paneLayout.dispatchGesture(gesture);
  }

  private publishPanels(state: HostPanelState): void {
    if (this.disposed) return;
    this.panelState = state;
    this.paneLayout.setState(state);
    this.dispatchEvent(new CustomEvent("opencraft-panels", { bubbles: true, composed: true, detail: state }));
  }

  /** Reuses the same Host and composer owners; never replays a submission. */
  async reconnect(): Promise<void> {
    await this.connection?.reconnect();
  }

  /** Painting waits for the local Draft only; sending stays gated on the Host connection. */
  async show(): Promise<void> {
    await this.prepare();
    await this.paintedPromise;
    if (this.disposed) throw new Error("Embedded Workbench is disposed");
    this.dataset.visible = "true";
    this.inert = false;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const application = this.application;
    // Let the host finish its show() handoff and paint before optional imports.
    requestAnimationFrame(() => {
      if (!this.disposed && !this.inert && this.application === application) {
        void application?.application.startOptionalFeatures();
      }
    });
  }

  hide(): void {
    this.inert = true;
    this.dataset.visible = "false";
  }

  selectConversation(conversationId: string): void {
    const normalized = conversationId.trim();
    if (!normalized || !this.sessions.has(normalized)) {
      throw new Error("Embedded Workbench conversation is unavailable");
    }
    if (this.selectedConversationId === normalized) return;
    const actions = this.requireActions();
    void actions.selectThread(normalized).catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /** A request is consumed only after this Bot's Conversation owner admits it. */
  submitPrompt(requestId: string, text: string): boolean {
    if (this.disposed || this.failed) return false;
    if (this.admittedPrompts.has(requestId)) return true;
    if (this.readyDetail === null || this.actions === null) return false;
    if (!this.actions.submitPrompt(text)) return false;
    this.admittedPrompts.add(requestId);
    return true;
  }

  async createConversation(): Promise<void> {
    await this.requireActions().createThread();
  }

  async loadMoreConversations(): Promise<void> {
    await this.requireActions().loadMoreThreads();
  }

  /** Host-controlled locale updates retain the application and draft identity. */
  async setLocalization(options: WorkbenchLocaleOptions): Promise<void> {
    if (this.disposed) throw new Error("Embedded Workbench is disposed");
    if (this.config === null) throw new Error("Embedded Workbench is not configured");
    this.config = Object.freeze({ ...this.config, localization: validateWorkbenchLocaleOptions(options) });
    await this.locale?.configure(this.localeOptions());
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    const session = this.requireSession(conversationId);
    const normalizedTitle = title.trim().slice(0, 50);
    if (!normalizedTitle || session.title === normalizedTitle) return;
    await this.requireActions().renameThread(session.chatId, normalizedTitle);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const session = this.requireSession(conversationId);
    await this.requireActions().deleteThread(session.chatId);
  }

  async setConversationPinned(conversationId: string, pinned: boolean): Promise<void> {
    const session = this.requireSession(conversationId);
    if (!this.pinSupported) throw new Error("This Host does not support conversation pinning");
    await this.requireActions().setThreadPinned(session.chatId, pinned);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    if (this.readyDetail === null && !this.failed) {
      this.rejectReady(new Error("Embedded Workbench was disposed before it became ready"));
    }
    if (!this.painted && !this.failed) {
      this.rejectPainted(new Error("Embedded Workbench was disposed before it painted"));
    }
    this.connection?.dispose();
    this.connection = null;
    this.stopTurnCompletionSubscription?.();
    this.stopTurnCompletionSubscription = null;
    this.root.unmount();
    this.locale?.dispose();
    this.localeObserver?.disconnect();
    this.localeObserver = null;
    this.locale = null;
    this.stopThemeSubscription?.();
    this.stopThemeSubscription = null;
    this.actions = null;
    this.panelCommand = null;
    this.panelState = null;
    this.paneLayout.dispose();
    const application = this.application;
    const preferences = this.preferences;
    this.application = null;
    this.preferences = null;
    await Promise.all([
      application?.dispose(),
      preferences?.close(),
    ]);
  }

  private async prepareOwned(config: EmbeddedWorkbenchConfig): Promise<void> {
    try {
      const application = await createEmbeddedChatApplication(config);
      this.application = application;
      const preferences = await openWorkbenchUiPreferences();
      if (this.disposed) {
        await Promise.all([application.dispose(), preferences.close()]);
        return;
      }
      this.application = application;
      this.preferences = preferences;
      this.locale = new WorkbenchLocaleController(preferences, this.localeOptions(), embeddedLocaleCatalogs);
      this.localeObserver = new MutationObserver(() => { void this.locale?.configure(this.localeOptions()); });
      this.localeObserver.observe(this.ownerDocument.documentElement, { attributes: true, attributeFilter: ["lang"] });
      await this.locale.initialize();
      if (this.disposed) return;
      const supervisor = application.application.supervisor;
      if (supervisor.mode !== "active") throw new Error("Embedded Host is unavailable");
      this.stopTurnCompletionSubscription = observeEmbeddedTurnCompletions(
        supervisor.appServerRegistry.clients,
        application.hostId,
        (detail) => {
          if (this.disposed) return;
          this.dispatchEvent(new CustomEvent<EmbeddedWorkbenchTurnCompletedDetail>(
            "opencraft-turn-completed",
            { detail },
          ));
        },
      );
      const runtime = supervisor.registry.getRuntime(application.hostId);
      this.connection = observeEmbeddedConnection(runtime, detail => {
        this.dispatchEvent(new CustomEvent("opencraft-connection", { detail }));
      });
      // The startup Draft is local identity, so the Composer can paint while the
      // Host connects. NewThreadDraftPage keeps submission disabled until ready;
      // prepare() resolves once painted and connection progress flows through
      // opencraft-connection events.
      this.renderApplication();
      await this.paintedPromise;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.fail(error);
      throw error;
    }
  }

  private handlePainted(): void {
    if (this.painted || this.disposed || this.failed) return;
    this.painted = true;
    this.resolvePainted();
  }

  private handleReady(threadId: string | null, config: EmbeddedWorkbenchConfig): void {
    this.selectedConversationId = threadId;
    if (this.readyDetail !== null) return;
    const detail = Object.freeze({
      threadId,
      hostId: this.application!.hostId,
      instanceId: config.instanceId,
      profileId: config.profileId,
    });
    requestAnimationFrame(() => {
      if (this.disposed || this.readyDetail !== null) return;
      this.readyDetail = detail;
      this.resolveReady(detail);
      this.dispatchEvent(new CustomEvent<EmbeddedWorkbenchReadyDetail>(
        "opencraft-ready",
        { detail },
      ));
    });
  }

  private handleSessions(detail: {
    readonly sessions: readonly EmbeddedWorkbenchSession[];
    readonly loading: boolean;
    readonly hasMoreSessions: boolean;
    readonly pinSupported: boolean;
    readonly selectedChatId: string | null;
    readonly isDraft: boolean;
  }): void {
    this.sessions = new Map(detail.sessions.map((session) => [session.chatId, session]));
    this.hasMoreSessions = detail.hasMoreSessions;
    this.pinSupported = detail.pinSupported;
    this.selectedConversationId = detail.selectedChatId;
    this.isDraft = detail.isDraft;
    this.publishSessions(detail.loading, null);
  }

  private bindActions(actions: EmbeddedWorkbenchAppActions): () => void {
    this.actions = actions;
    return () => {
      if (this.actions === actions) this.actions = null;
    };
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    if (!this.failed && this.readyDetail === null) {
      this.failed = true;
      this.rejectReady(error);
      if (!this.painted) this.rejectPainted(error);
    }
    this.dispatchEvent(new CustomEvent("opencraft-error", {
      detail: Object.freeze({ message: error.message }),
    }));
  }

  private renderApplication(): void {
    const application = this.application;
    const preferences = this.preferences;
    const config = this.config;
    const locale = this.locale;
    if (application === null || preferences === null || config === null || locale === null || this.disposed) return;
    this.root.render(
      <EmbeddedWorkbenchErrorBoundary onError={(error) => this.fail(error)}>
        <UiPreferencesProvider runtime={preferences}>
          <WorkbenchIntlProvider controller={locale} target={this}>
          <EmbeddedChatRoot
            application={application.application}
            bindActions={(actions) => this.bindActions(actions)}
            hostId={application.hostId}
            onError={(error) => this.fail(error)}
            onPainted={() => this.handlePainted()}
            onReady={(threadId) => this.handleReady(threadId, config)}
            onSessionsChange={(detail) => this.handleSessions(detail)}
            portalContainer={config.externalPanelChrome ? this.overlayMount : this.mount}
            panelHost={config.externalPanelChrome ? {
              target: this.panelMount,
              presentation: this.paneLayout,
              publish: state => this.publishPanels(state),
              bind: command => {
                this.panelCommand = command;
                return () => { if (this.panelCommand === command) this.panelCommand = null; };
              },
            } : undefined}
          />
          </WorkbenchIntlProvider>
        </UiPreferencesProvider>
      </EmbeddedWorkbenchErrorBoundary>,
    );
  }

  private requireActions(): EmbeddedWorkbenchAppActions {
    if (this.actions === null || this.disposed) {
      throw new Error("Embedded Workbench is not ready");
    }
    return this.actions;
  }

  private requireSession(conversationId: string): EmbeddedWorkbenchSession {
    const session = this.sessions.get(conversationId.trim());
    if (session === undefined) throw new Error("Embedded Workbench conversation is unavailable");
    return session;
  }

  private publishSessions(loading: boolean, error: string | null): void {
    this.dispatchEvent(new CustomEvent<EmbeddedWorkbenchSessionsDetail>(
      "opencraft-sessions",
      {
        detail: Object.freeze({
          sessions: Object.freeze([...this.sessions.values()]),
          loading,
          hasMoreSessions: this.hasMoreSessions,
          pinSupported: this.pinSupported,
          error,
          selectedChatId: this.selectedConversationId,
          isDraft: this.isDraft,
        }),
      },
    ));
  }

  private syncTheme(): void {
    applyAppearanceThemeToElement(this, getAppearanceThemeSnapshot());
  }

  private localeOptions(): WorkbenchLocaleOptions {
    return { ...this.config?.localization,
      ideLocale: this.config?.localization?.ideLocale ?? (this.ownerDocument.documentElement.lang || null),
    };
  }
}

export function defineOpenCraftEmbeddedWorkbench(): void {
  if (!customElements.get(ELEMENT_NAME)) {
    customElements.define(ELEMENT_NAME, OpenCraftEmbeddedWorkbenchElement);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "opencraft-embedded-workbench": OpenCraftEmbeddedWorkbenchElement;
  }
}
