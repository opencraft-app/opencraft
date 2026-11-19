import { productPluginPacks } from '../../apps/workbench-web/product-plugin-packs.vite.ts';
import { joinProductPluginBuilds } from './plugin-packs/builds.mjs';
import { createWorkbenchWebConfig } from "../../apps/workbench-web/vite.config.ts";

export default environment => {
  const config = createWorkbenchWebConfig(environment, { tasksPresentation: false });
  config.plugins.push(productPluginPacks(joinProductPluginBuilds));
  // Both workspace locks select these exact versions.
  config.resolve.dedupe.push("react-intl", "@radix-ui/react-alert-dialog", "@floating-ui/core",
    "@floating-ui/dom", "@floating-ui/react-dom", "@floating-ui/utils", "react-remove-scroll",
    "aria-hidden", "tslib");
  const groups = config.build.rolldownOptions.output.codeSplitting.groups;
  // Removing optional Views changes the small-module merge heuristic. Keep
  // preview implementations/styles on their existing demand-only paths.
  groups.unshift(
    { name: 'file-preview-dialog-view', test: /\/packages\/file-preview-web\/src\/file-preview-dialog-view\.tsx$/, includeDependenciesRecursively: false },
    { name: 'mermaid-preview-styles', test: /\/packages\/chat-render-web\/src\/extensions\/mermaid\/mermaid-preview\.scss(?:\?.*)?$/, includeDependenciesRecursively: false },
  );
  const startup = groups.find(group => group.name === "startup-composition");
  // Mandatory control and presentation facades share the bootstrap owner.
  // CSS-only facades belong here too: empty JS requests add high-RTT latency.
  startup.test = /(?:\/runtime\/(?:web-workbench-supervisor|web-workbench-application|server-product-extensions)\.ts|\/products\/join\/web\.ts|\/components\/(?:ui\/button|workbench-presentation-root)\.tsx|\/src\/(?:components\/(?:draft-setup-notice|async-notices)|styles\/context-menu)\.scss)$/;
  // Mandatory Shell context and keyboard facades already participate in startup.
  // Keep their small exports in the composition owner instead of separate requests.
  const contextFacades = /\/src\/(?:workbench-shortcuts|internal-developer-mode|runtime\/(?:scheduled-task-catalog-context|selection-preferences)|components\/(?:async-notices-context|shell-presentation|panel-navigation|workbench-presentation-activity))\.tsx?$/;
  // These already-critical, dependency-light facades otherwise become 83–331 B
  // requests. Share their existing bootstrap owner, not an optional feature pack.
  const controlFacades = /(?:\/packages\/composer-core\/src\/catalog\.ts|\/components\/(?:modal\/modal-surface|shell-navigation\/navigation-button)\.tsx|\/components\/conversation-rename-dialog\.scss)$/;
  startup.test = new RegExp([startup.test.source, contextFacades.source, controlFacades.source].join("|"));
  // This dependency-free identity facade is already on the critical path;
  // share its bootstrap owner instead of paying for a separate tiny request.
  startup.test = new RegExp(startup.test.source + "|/plugins/builtin-agents/src/server-connection-identity\\.ts$");
  // Back/sidebar and Shell transitions already require this complete runtime.
  // Coalesce it without recursively importing any optional feature dependencies.
  groups.unshift({ name: "motion-runtime", test: /\/node_modules\/(?:framer-motion|motion-dom|motion-utils)\//, includeDependenciesRecursively: false });
  return config;
};
