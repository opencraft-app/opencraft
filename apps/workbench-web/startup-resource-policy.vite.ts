/** Conservative union of Web/embedded bootstrap, required providers and Shell.
 * Deferred presentation and protocol implementation must not enter this graph.
 * CPU/paint/power still require browser/device measurement; bytes are a gate,
 * not a substitute for those observations.
 */
// Question cards participate in initial transcript layout. Their 9.3 KB of
// uncompressed styles are required with the renderer, not a late title fallback.
// Shared material roles and accessibility fallbacks bring measured startup CSS
// to 712,159 bytes. Reserve 4 KB for this shared paint; retain JS/transfer limits
// and demand-only module boundaries.
// Account-scoped resource convergence adds 1.4 KB gzip to the deployed startup
// graph (measured 1,200,955 bytes). Reserve 2 KB for this required lifecycle
// service; retain JS/CSS/chunk and demand-only boundaries. Do not defer resource
// ownership initialization merely to move its bytes outside this accounting.
// Send/stream motion keeps its flight module lazy. Its keyframes and bubble
// hook measured 1,202,391 B gzip; revision hashes in chunk names vary the total
// by about 200 B between otherwise identical builds, so reserve that too.
// Bounded refresh previews and their whitelist parser must be present before
// the first cached transcript commit. Measured formal Join build:1,204,932 B
// gzip (all JS/CSS/demand-only/chunk gates pass). Reserve2 KB for this synchronous
// restoration, including content-hash variance; do not defer it behind hydration.
// Durable custody and terminal receipt projection must precede the first
// transcript paint. Formal Join build measured 1,207,034 B gzip; reserve 2 KB
// over the prior cap for this model, preserving JS/CSS/chunk/demand-only gates.
// Explicit side-chat ownership and the revision-fenced v1 compatibility
// projection must precede the first ordinary-catalog paint. Matched formal Join
// builds measured 1,209,835 B before and 1,211,407 B after (+1,572 B gzip).
// Reserve 2 KB for this required ownership model and chunk-hash variance;
// retain JS/CSS/chunk limits and all demand-only boundaries unchanged.
// Browser auth-expiry admission and its explicit recovery notice are required
// before opening a headless connection. Formal Join build measured1,212,052 B
// gzip, +720 B over the deployed1,211,332 B. Reserve1 KB for this recovery
// and chunk-hash variance; preserve all
// JS/CSS/chunk limits and demand-only module boundaries.
// Managed-assistant environment choices and portable attachment cancellation are
// part of the measured initial Join graph: 1,213,036 B gzip. Reserve 1 KB over
// the previous cap for these capabilities and content-hash variance. Keep all
// JS/CSS/chunk and demand-only boundaries unchanged.
// Historical file-operation recovery must run in the shared first-paint
// projection, including metadata-only histories. The formal Join build measured
// 1,213,677 B gzip. Reserve 1 KB beyond the managed-assistant accounting for
// this synchronous recovery and content-hash variance; preserve JS/CSS/chunk
// limits and every demand-only boundary.
// Shared portrait first-paint settling and unified footer spacing measured
// 1,215,058 B gzip in the full Join graph. Reserve 500 B for this required Shell
// correction and content-hash variance; no JS/CSS/chunk or demand gate changes.
// Current integrated baseline measures 1,216,845 B gzip; group recovery is
// 1,216,726 B with the same builder. Keep 655 B of measured graph/hash headroom;
// this does not expand JS/CSS/chunk limits or any demand-only boundary.
// Integrated navigation slots and Goal mutation safeguards measure 1,217,926 B
// gzip (+293 B over the prior Assets candidate). Keep 574 B of graph/hash
// headroom. Assets collection/sheet modules remain demand-only; JS/CSS/chunk
// limits and all demand-only boundaries are unchanged.
// Durable browser retirement and foreground receipt reconciliation must be ready
// before restored tabs are admitted. They add roughly 3 KB gzip to the deployed
// graph; reserve 4 KB including hash variance. Keep JS/CSS/chunk limits and all
// demand-only media, input, annotation and preview boundaries unchanged.
export const startupResourceBudget = Object.freeze({ javascript: 3_700_000, css: 734_000, gzip: 1_225_500 });
export const startupJavaScriptChunkBudget = 120;
export const requiredStartupModule = /\/(?:apps\/workbench-web\/src\/(?:workbench-entry|main)\.tsx?|plugins\/(?:builtin-agents|headless-model-services)\/src\/runtime-entry\.tsx?|plugins\/builtin-agents\/src\/index\.tsx?)$/;
/** Trusted build owners may add roots and exclusions without relaxing core limits. */
export interface StartupResourcePolicy {
  readonly requiredModules?: readonly RegExp[];
  readonly demandOnlyModules?: readonly RegExp[];
}
const demandOnlyPatterns = [
  /\/apps\/workbench-web\/src\/components\/archived-threads-settings\.tsx$/,
  /\/plugins\/cloud-desktop\/src\/(?:session-wire|rfb|rfb-client|pointer-input|text-input|clipboard-input|trackpad-input|frame-preview)\.ts$/,
  /\/apps\/workbench-web\/src\/components\/agent-(?:onboarding\.(?:tsx|scss)|management\.tsx|directory\.tsx|history-import\.tsx)$/,
  /\/apps\/workbench-web\/src\/i18n\/embedded-companion-messages\.json$/,
  /\/packages\/composer-editor\/src\/composer-model-menu\.tsx$/,
  /\/packages\/design-system-web\/src\/discrete-slider\.tsx$/,
  /\/packages\/workbench-runtime\/src\/side-chat\/policy\.ts$/,
  /\/packages\/timeline-host-web\/src\/scroll-frame-diagnostics\.ts$/,
  /\/apps\/workbench-web\/src\/runtime-diagnostic-snapshot\.ts$/,
  /\/packages\/composer-appserver\/src\/compiler\.ts$/,
  /\/packages\/chat-render-web\/src\/extensions\/mermaid\/mermaid-preview-surface\.tsx$/,
  /\/packages\/(?:file-preview-web\/src\/file-preview-(?:dialog-)?view|chat-render-web\/src\/renderers\/table\/table-preview|design-system-web\/src\/preview-surface)\.tsx$/,
  /\/packages\/file-preview-web\/src\/pdf\.scss\?inline$/,
  /\/plugins\/(?:office-preview|structured-preview)\/src\/preview\.web\.scss\?inline$/,
  /\/plugins\/image-editor\/src\/editor\.web\.scss\?inline$/,
  /\/browser\/(?:remote-browser-media-runtime|h264-media-source)\.ts$/,
  /\/browser\/remote-browser-(?:input-runtime|ime|edit-input|input-queue)\.ts$/,
  /\/browser\/browser-local-menu-view\.tsx$/,
  /\/builtin-agents\/src\/model-policy-view\.tsx$/,
  /\/builtin-agents\/src\/model-services\/personal\.tsx$/,
  /\/browser-annotation\/(?:screenshot(?:-geometry)?\.ts|composer-sink-runtime\.tsx|(?:annotation-layer|annotation-selection-controls)\.tsx|browser-annotation\.scss|frame\/(?:frame-agent|frame-source|guest-annotator)\.ts)$/,
  /\/packages\/browser-preview-bridge\/src\/runtime\.ts$/,
  /\/packages\/design-system-web\/src\/liquid-glass-map\.tsx$/,
  /\/packages\/(?:design-system-web\/src\/progress-bar\.tsx|design-system\/src\/progress-bar\.web\.scss)$/,
  /\/packages\/composer-editor\/src\/message\.web\.scss$/,
  /\/components\/conversation-appearance-picker\.tsx$/,
  /\/packages\/design-system-web\/src\/color-input\.(?:tsx|web\.scss)$/,
  /\/components\/conversation-search-dialog\.tsx$/,
  /\/components\/connectors\/connector-(?:library|native-services|setup)\.tsx$/,
  /\/components\/extensions\/extension-library\.tsx$/,
  /\/chat-render-web\/src\/renderers\/visualization\/(?:visualization\.tsx|sandbox\.ts)$/,
  /\/packages\/appserver-session\/src\/derived-history\.ts$/,
  /\/apps\/workbench-web\/src\/components\/modal\/adaptive-sheet-handle\.tsx$/,
  /\/packages\/design-system-web\/src\/adaptive-sheet\.(?:tsx|scss)$/,
  /\/chat-render-web\/src\/extensions\/katex\/katex-math\.tsx$/,
  /\/node_modules\/(?:parse5|acorn)\//,
  /\/cloud-desktop\/src\/panel\.tsx$/,
  /\/builtin-agents\/src\/(?:model-services|codex-accounts|ssh-connections)\/view\./,
  /\/panels\/workspace-resource-panel\./,
];
export const demandOnlyModule = new RegExp(demandOnlyPatterns.map(pattern => pattern.source).join("|"));
export interface StartupResourceReport {
  readonly critical: readonly string[];
  readonly chunks: readonly { readonly file: string; readonly modules: readonly string[] }[];
  readonly totals: { readonly javascript: number; readonly css: number; readonly gzip: number };
}
export function startupResourceViolations(report: StartupResourceReport, policy: StartupResourcePolicy = {}): string[] {
  const critical = new Set(report.critical);
  const violations: string[] = [];
  const javascriptChunks = report.chunks.filter(chunk => critical.has(chunk.file) && chunk.file.endsWith(".js")).length;
  if (javascriptChunks > startupJavaScriptChunkBudget) violations.push(`Startup JS chunks: ${javascriptChunks} > ${startupJavaScriptChunkBudget}`);
  for (const chunk of report.chunks) {
    if (!critical.has(chunk.file)) continue;
    for (const module of chunk.modules) {
      if (demandOnlyModule.test(module) || policy.demandOnlyModules?.some(pattern => pattern.test(module))) {
        violations.push(`Demand-only startup module: ${module}`);
      }
    }
  }
  for (const key of Object.keys(startupResourceBudget) as (keyof typeof startupResourceBudget)[]) {
    if (report.totals[key] > startupResourceBudget[key]) violations.push(`Startup ${key}: ${report.totals[key]} > ${startupResourceBudget[key]}`);
  }
  return violations;
}
