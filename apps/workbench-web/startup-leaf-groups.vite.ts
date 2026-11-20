/** These leaves already belong to the measured startup closure. Coalesce their
 * tiny requests without pulling recursive dependencies or optional implementations
 * into bootstrap. Source ESM execution order remains enforced by the build owner. */
export const startupLeafGroups = [
  {
    name: "startup-presentation-leaves",
    includeDependenciesRecursively: false,
    test: /\/apps\/workbench-web\/src\/(?:runtime\/(?:mini-apps|mobile-container|edge-gesture-bridge|workbench-preview|conversation-content-search)|components\/(?:use-presentation-completion|modal\/confirmation-top-layer)|browser\/browser-presentation-geometry|mcp-apps\/contract)\.tsx?$/,
  },
  {
    name: "motion-context-leaves",
    includeDependenciesRecursively: false,
    test: /\/node_modules\/(?:framer-motion\/dist\/es\/(?:context\/(?:LayoutGroupContext|MotionConfigContext|PresenceContext)|utils\/(?:use-constant|is-browser|use-isomorphic-effect|reduced-motion\/use-reduced-motion)|components\/AnimatePresence\/use-presence)|motion-dom\/dist\/es\/utils\/is-html-element|motion-utils\/dist\/es\/is-object)\.mjs$/,
  },
  {
    name: "startup-dom-leaves",
    includeDependenciesRecursively: false,
    test: /\/node_modules\/(?:aria-hidden\/dist\/es2015\/index|react-use-event-hook\/dist\/esm\/useEvent|tslib\/tslib\.es6|w3c-keyname\/index)\.m?js$/,
  },
];
