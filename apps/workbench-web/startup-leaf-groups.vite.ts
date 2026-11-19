/** Co-locate required vendor/paint owners and small startup leaves instead of
 * fragmenting them by every optional consumer. Recursive dependency capture stays
 * disabled; demand-only implementations keep separate groups in the build owner. */
export const startupLeafGroups = [
  // This registration references a deferred extension. Its changing import hash
  // must not invalidate the presentation/focus leaves used throughout the Shell.
  {
    name: "token-usage-registration",
    includeDependenciesRecursively: false,
    test: /\/apps\/workbench-web\/src\/runtime\/token-usage-builtin\.ts$/,
  },
  // Keep compatible-but-distinct installed Slot helpers together without
  // deduplicating versions or capturing unrelated nested dependency trees.
  {
    name: "slot-runtime",
    includeDependenciesRecursively: false,
    test: (id: string) => (id.split("/node_modules/")[1] ?? "").startsWith("@radix-ui/")
      && /\/node_modules\/@radix-ui\/react-slot\//.test(id),
  },
  {
    name: "query-runtime",
    includeDependenciesRecursively: false,
    test: /\/node_modules\/@tanstack\/(?:query-core|react-query)\//,
  },
  {
    name: "intl-runtime",
    includeDependenciesRecursively: false,
    test: /\/node_modules\/(?:@formatjs|intl-messageformat|react-intl)\//,
  },
  {
    name: "editor-runtime",
    includeDependenciesRecursively: false,
    test: /\/node_modules\/(?:prosemirror-[^/]+|orderedmap|rope-sequence|w3c-keyname)\//,
  },
  {
    name: "shared-artwork",
    includeDependenciesRecursively: false,
    test: /\/packages\/(?:design-system\/src\/(?:action-artwork|progress.shared|sidebar-toggle-glyphs)|design-system-web\/src\/(?:icon-glyph|shared-action-icons|interface-icons|image-edit-icons|activity-icons|layout-icons|agent-brand-artwork|agent-brand-icon|recovery-scan|sidebar-toggle-icon|file-folder-artwork|action-icons))\.tsx?$/,
  },
  // The complete motion runtime is already required by initial Shell gestures
  // and layout. Keep it together rather than fragmenting it by lazy consumers.
  {
    name: "motion-runtime",
    includeDependenciesRecursively: false,
    test: /\/node_modules\/(?:motion|framer-motion|motion-dom|motion-utils)\//,
  },
  {
    name: "startup-presentation-leaves",
    includeDependenciesRecursively: false,
    test: /\/apps\/workbench-web\/src\/(?:runtime\/(?:mini-apps|mobile-container|edge-gesture-bridge|workbench-preview|conversation-content-search)|components\/(?:use-presentation-completion|modal\/confirmation-top-layer)|browser\/browser-presentation-geometry|mcp-apps\/contract)\.tsx?$/,
  },
  {
    name: "startup-dom-leaves",
    includeDependenciesRecursively: false,
    test: /\/node_modules\/(?:aria-hidden\/dist\/es2015\/index|react-use-event-hook\/dist\/esm\/useEvent|tslib\/tslib\.es6|w3c-keyname\/index)\.m?js$/,
  },
];
