import type { Rolldown } from "vite";
import { startupLeafGroups } from "./startup-leaf-groups.vite";
import { demandOnlyModule, requiredStartupModule, type StartupResourcePolicy } from "./startup-resource-policy.vite";

export type WorkbenchChunkGroup = Rolldown.CodeSplittingGroup;

/** Trusted product additions to core's chunk topology. Core owns the order. */
export interface WorkbenchChunkGroupOptions {
  /**
   * Mandatory startup facades merged into core's `startup-composition` group.
   * They are added to core's own startup modules and never replace them.
   * Each pattern must be a flag-free RegExp matched against the module id.
   */
  readonly startupModules?: readonly RegExp[];
  /**
   * Product-owned groups, placed ahead of every core group in the given order.
   * A module matched by both a product group and a core group therefore joins
   * the product group. Names must not reuse a core group name, and `priority`
   * is reserved to core so this documented order stays the only rule.
   */
  readonly productChunkGroups?: readonly WorkbenchChunkGroup[];
}

/** Core's own mandatory startup composition modules. */
export const coreStartupCompositionModules =
  /\/runtime\/(?:web-workbench-supervisor|web-workbench-application|token-usage-builtin)\.ts$/;

function startupCompositionTest(startupModules: readonly RegExp[] = []): RegExp {
  if (!startupModules.length) return coreStartupCompositionModules;
  for (const pattern of startupModules) {
    if (!(pattern instanceof RegExp) || pattern.flags) {
      throw new Error("Workbench startupModules entries must be RegExp patterns without flags");
    }
  }
  return new RegExp(
    [coreStartupCompositionModules, ...startupModules].map((pattern) => `(?:${pattern.source})`).join("|"),
  );
}

/**
 * Build the Web code-splitting groups. Without options the result is core's
 * topology unchanged; product groups come first, then core groups in order.
 */
export function createWorkbenchChunkGroups(options: WorkbenchChunkGroupOptions = {}, startupGroup?: WorkbenchChunkGroup): WorkbenchChunkGroup[] {
  const coreGroups: WorkbenchChunkGroup[] = [
    ...startupLeafGroups,
    // This requested queue UI shares tiny control leaves with Main.
    // Keep it separate as lazy Settings consumers change chunk grouping.
    {
      name: "local-queued-messages",
      test: /\/packages\/composer-editor\/src\/local-queued-messages\.tsx$/,
      includeDependenciesRecursively: false,
    },
    // Keep file artwork and link menus on their demand-only paths;
    // small-chunk merging must not hoist them back into bootstrap.
    {
      name: "chat-link-presentations",
      test: /(?:\/packages\/chat-render-web\/src\/renderers\/resource-link\/(?:resource-chip|external-url-link)\.(?:tsx|scss)(?:\?.*)?$|\/packages\/chat-render-react\/src\/file-resource-presentation\.ts$)/,
      includeDependenciesRecursively: false,
    },
    // These already-required control/context leaves otherwise become
    // many sub-1KB requests whose raw-byte accounting and import headers
    // exceed their content. Share one stable chunk; do not add lazy UI.
    {
      name: "workbench-control-leaves",
      test: /(?:\/apps\/workbench-web\/src\/(?:components\/(?:ui\/button|modal\/modal-surface|shell-navigation\/navigation-button|workbench-presentation-activity|ui\/workbench-icon|async-notices-context|workbench-presentation-root|conversation\/document-context)|panels\/prepare-preview-resources|runtime\/(?:panel-runtime-context|restore-right-panel-tabs)|workbench-shortcuts)\.tsx?$|\/apps\/workbench-web\/src\/(?:browser-annotation\/composer-sink|runtime\/scheduled-task-catalog-context)\.tsx?$|\/plugins\/cloud-desktop\/src\/contract\.ts$|\/viewport-presets\.js$)/,
      includeDependenciesRecursively: false,
    },
    // Settings-only connection/welcome surfaces share tiny branding
    // helpers with Sidebar. Do not hoist the surfaces with those helpers.
    {
      name: "connection-settings-presentation",
      test: /\/apps\/workbench-web\/src\/components\/mobile-connection-settings\.tsx$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "right-panel-presentation",
      test: /\/apps\/workbench-web\/src\/components\/right-panel\.tsx$/,
      includeDependenciesRecursively: false,
    },
    // Agent setup and history import are requested presentations, not
    // bootstrap owners. Shared Sidebar helpers must not hoist their UI.
    {
      name: "agent-onboarding",
      test: /\/apps\/workbench-web\/src\/components\/(?:agent-management|agent-onboarding|agent-history-import)\.(?:tsx|scss)$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "side-chat-policy",
      test: /\/packages\/workbench-runtime\/src\/side-chat\/policy\.ts$/,
      includeDependenciesRecursively: false,
    },
    // Submission validation is loaded on send, not on every cold open.
    {
      name: "submit-compiler",
      test: /\/packages\/composer-appserver\/src\/compiler\.ts$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "mermaid-preview-surface",
      test: /\/packages\/chat-render-web\/src\/extensions\/mermaid\/mermaid-preview-surface\.tsx$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "preview-surface",
      test: /\/packages\/design-system-web\/src\/preview-surface\.tsx$/,
      includeDependenciesRecursively: false,
    },
    // Keep the deferred dialog owner out of tiny shared startup groups.
    // Protocol helpers shared with Main must not pull its PreviewSurface
    // (and its imports) into the cold-open graph.
    {
      name: "file-preview-dialog",
      test: /\/packages\/file-preview-web\/src\/file-preview-dialog-view\.tsx$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "file-preview-view",
      test: /\/packages\/file-preview-web\/src\/file-preview-view\.tsx$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "table-preview",
      test: /\/packages\/chat-render-web\/src\/renderers\/table\/table-preview\.tsx$/,
      includeDependenciesRecursively: false,
    },
    // Shared context leaves are already required at startup. New lazy
    // consumers should not turn each small context into another request.
    {
      name: "workbench-context",
      test: /\/apps\/workbench-web\/src\/(?:browser-annotation\/composer-sink|runtime\/scheduled-task-catalog-context|components\/(?:async-notices-context|conversation\/document-context|workbench-presentation-root))\.tsx?$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "workbench-context",
      test: /(?:\/runtime\/(?:appserver-runtime-context\.tsx|workbench-application-services\.ts)|\/components\/conversation-appearance\.(?:tsx|scss)|\/packages\/ui-preferences\/src\/(?:index|conversation-appearance)\.ts)$/,
      includeDependenciesRecursively: false,
    },
    // Keep the injected page implementation separate from the startup
    // transport protocol, even when they share dynamic consumers.
    {
      name: "browser-page-runtime",
      test: /\/packages\/browser-preview-bridge\/src\/(?:runtime|annotation-picker)\.ts$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "shell-helpers",
      test: /(?:\/runtime\/selection-preferences\.ts|\/components\/(?:panel-navigation|shell-presentation)\.ts|\/src\/internal-developer-mode\.ts)$/,
      includeDependenciesRecursively: false,
    },
    // Keep demand-loaded history out of small shared startup chunks as consumers change.
    {
      name: "derived-history",
      test: /\/packages\/appserver-session\/src\/derived-history\.ts$/,
      includeDependenciesRecursively: false,
    },
    // Optical maps load only when an eligible glass surface requests them.
    {
      name: "liquid-glass-optics",
      test: /\/packages\/design-system-web\/src\/liquid-glass-map\.tsx$/,
      includeDependenciesRecursively: false,
    },
    // Optional document engines also import server rendering helpers; keep those
    // with their lazy consumers instead of the startup React runtime.
    {
      name: "react-runtime",
      test: (id) =>
        (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id) &&
          !/\/react-dom\/(?:server(?:[./-])|cjs\/react-dom-server)/.test(id)) ||
        id.includes("__vite-optional-peer-dep:@emotion/is-prop-valid:framer-motion"),
      includeDependenciesRecursively: false,
    },
    {
      name: "startup-composition",
      test: startupCompositionTest(options.startupModules),
      includeDependenciesRecursively: false,
    },
    // Keep the shared dynamic-import helper separate from entry-only
    // modulepreload side effects and their application hash references.
    { name: "vite-preload-runtime", test: /\0vite\/preload-helper\.js$/, includeDependenciesRecursively: false },
    {
      name: "workbench-entry",
      test: /\/src\/workbench-(?:entry\.ts|root\.tsx)(?:\?.*)?$/,
      includeDependenciesRecursively: false,
    },
    { name: "workbench-shell", test: /\/apps\/workbench-web\/src\/app\.tsx$/, includeDependenciesRecursively: false },
    // Inline CSS is executable JS. Let import ownership split it: a shared
    // preview base must not pull lazy PDF, office or editor styles into startup.
    // Notices and rename dialogs share generated typography. Keep their
    // styles together when another lazy management page shares a Modal,
    // so the common typography sheet is emitted once at startup.
    {
      name: "workbench-feedback-styles",
      test: /(?:\/components\/(?:async-notices|conversation-rename-dialog)\.scss$|\/styles\/context-menu\.scss$|\/node_modules\/@fontsource-variable\/(?:inter|jetbrains-mono)\/wght(?:-italic)?\.css$)/,
      includeDependenciesRecursively: false,
    },
    // These small shared primitives are needed by entry controls and
    // deferred management pages. Keep one request instead of splitting
    // every new consumer set into its own tiny startup chunk.
    {
      name: "management-shared",
      test: (id) =>
        /\/(?:apps\/workbench-web\/src\/components\/(?:modal\/(?:index|modal-controller|modal-host|confirmation-modal-surface|announcement-dialog|announcement-modal-projection|announcement-lab|announcement-media-url|management-settings-content)\.tsx?|connectors\/connector-icon\.tsx)|packages\/connector-core\/src\/(?:index|catalog)\.ts)$/.test(
          id,
        ) || /\/apps\/workbench-web\/src\/assets\/announcement-lab\.svg\?/.test(id),
      includeDependenciesRecursively: false,
    },
    // Conversation appearance and preferences are shared startup context;
    // lazy picker consumers must not create extra tiny startup requests.
    // Keep the native color control and its shared Sass output with the
    // picker. The small-module merge heuristic otherwise hoists its CSS.
    // Companion paint belongs to the deferred member directory, not bootstrap.
    {
      name: "companion-avatar",
      test: /\/packages\/design-system-web\/src\/companion-avatar\.(?:tsx|scss)$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "conversation-appearance-picker",
      test: /(?:\/components\/conversation-appearance-picker\.(?:tsx|scss)|\/packages\/design-system-web\/src\/color-input\.(?:tsx|web\.scss))$/,
      includeDependenciesRecursively: false,
    },
    // Mandatory popup/focus primitives share one stable startup chunk.
    // Match the top-level dependency owner, never a drawing engine's
    // nested optional copy of the same library.
    {
      name: "overlay-runtime",
      test: (id) =>
        /^(?:@radix-ui\/(?:number|primitive|react-(?:alert-dialog|arrow|collection|compose-refs|context|context-menu|dialog|direction|dismissable-layer|dropdown-menu|focus-guards|focus-scope|id|menu|popover|popper|portal|presence|primitive|roving-focus|slider|slot|tooltip|use-callback-ref|use-controllable-state|use-effect-event|use-is-hydrated|use-layout-effect|use-size|visually-hidden))|@floating-ui\/(?:core|dom|react-dom|utils)|get-nonce|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar)\//.test(
          id.split("/node_modules/")[1] ?? "",
        ),
      includeDependenciesRecursively: false,
    },
    { name: "vendor", test: /\/node_modules\//, entriesAware: true, includeDependenciesRecursively: false },
    // Keep the demand-loaded math renderer out of small shared protocol
    // chunks. Their CSS otherwise becomes part of every startup closure.
    {
      name: "math-renderer",
      test: /\/packages\/chat-render-web\/src\/extensions\/katex\/(?:katex-math\.tsx|katex\.scss)$/,
      includeDependenciesRecursively: false,
    },
    // Optional identity extensions change the small shared-module groups.
    // Keep visualization's implementation behind its existing lazy boundary.
    {
      name: "visualization-renderer",
      test: /\/packages\/chat-render-web\/src\/renderers\/visualization\/(?:visualization\.(?:tsx|scss)|sandbox\.ts)$/,
      includeDependenciesRecursively: false,
    },
    // Keep small demand-loaded information styles out of the shared
    // platform chunk; entriesAware's merge threshold would hoist them.
    // Native message adapters and styles belong to their lazy channel consumer.
    {
      name: "message-timeline",
      test: /\/packages\/(?:chat-render-web\/src\/message-timeline\.tsx|timeline-host-web\/src\/timeline-viewport-owner\.ts|timeline-virtualizer\/src\/timeline\.ts)$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "adaptive-sheet",
      test: /\/packages\/design-system-web\/src\/adaptive-sheet\.(?:tsx|scss)$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "progress-bar",
      test: /\/packages\/(?:design-system-web\/src\/progress-bar\.tsx|design-system\/src\/progress-bar\.web\.scss)$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "message-composer",
      test: /\/packages\/composer-editor\/src\/message\.web\.scss$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "information-panel",
      test: /\/packages\/design-system\/src\/information-panel\.web\.scss$/,
      includeDependenciesRecursively: false,
    },
    {
      name: "platform",
      test: /\/packages\//,
      entriesAware: true,
      entriesAwareMergeThreshold: 4_000,
      includeDependenciesRecursively: false,
    },
  ];
  const productGroups = options.productChunkGroups ?? [];
  const coreNames = new Set(coreGroups.map((group) => group.name));
  for (const group of productGroups) {
    if (typeof group.name !== "string" || !group.name || coreNames.has(group.name)) {
      throw new Error(`Workbench product chunk group needs a unique name: ${String(group.name)}`);
    }
    if (group.priority !== undefined)
      throw new Error(`Workbench product chunk group ${group.name} must not set priority`);
  }
  // Claim the AppHost entry's dependencies before the general startup
  // coalescer can merge them into UI chunks.
  const deploymentAppHost: WorkbenchChunkGroup = {
    name: "deployment-app-host-startup",
    includeDependenciesRecursively: true,
    test: /\/apps\/workbench-web\/src\/runtime\/(?:deployment-app-host-startup|websocket-app-host)\.ts$/,
  };
  return [...productGroups, deploymentAppHost, ...(startupGroup ? [startupGroup] : []), ...coreGroups];
}

/** Coalesce small modules already required on the same startup paths.
 * Follow static imports only and keep optional implementations and existing
 * startup entry boundaries in their own chunks. */
export function startupChunking(policy: StartupResourcePolicy = {}) {
  const modules = new Map<string, {
    isEntry: boolean;
    importedIds: readonly string[];
    dynamicallyImportedIds: readonly string[];
  }>();
  let startupModules: Set<string> | undefined;
  const normalize = (id: string) => id.replace(/\?.*$/u, "").replaceAll("\\", "/");
  const startupRoot = (id: string) => requiredStartupModule.test(normalize(id)) ||
    policy.requiredModules?.some(pattern => pattern.test(normalize(id))) === true;
  const collect = () => {
    const reachable = new Set<string>();
    const visit = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      for (const child of modules.get(id)?.importedIds ?? []) visit(child);
    };
    for (const [id, info] of modules) if (info.isEntry || startupRoot(id)) visit(id);
    return reachable;
  };
  const group: WorkbenchChunkGroup = {
    debugName: "startup-static-dependencies",
    name: id => normalize(id).includes("/node_modules/") ? "startup-vendor-dependencies" : "startup-package-dependencies",
    test: id => {
      const info = modules.get(id);
      const modulePath = normalize(id);
      if (id.startsWith("\0") || !info || info.isEntry || info.dynamicallyImportedIds.length ||
        !/\/(?:node_modules|packages)\//u.test(modulePath) ||
        startupRoot(id) || !/\.[cm]?[jt]sx?(?:\?|$)/u.test(id) || demandOnlyModule.test(id) ||
        policy.demandOnlyModules?.some(pattern => pattern.test(id))) return false;
      return (startupModules ??= collect()).has(id);
    },
    maxSize: 360_000,
    includeDependenciesRecursively: false,
  };
  return {
    group,
    plugin: {
      name: "opencraft-coalesce-startup-chunks",
      buildStart() { modules.clear(); startupModules = undefined; },
      moduleParsed({ id, isEntry, importedIds, dynamicallyImportedIds }: {
        id: string; isEntry: boolean; importedIds: readonly string[]; dynamicallyImportedIds: readonly string[];
      }) {
        modules.set(id, { isEntry, importedIds, dynamicallyImportedIds });
      },
    },
  };
}
