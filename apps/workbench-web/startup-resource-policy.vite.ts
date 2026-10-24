/** Conservative union of Web/embedded bootstrap, required providers and Shell.
 * Deferred presentation and protocol implementation must not enter this graph.
 * CPU/paint/power still require browser/device measurement; bytes are a gate,
 * not a substitute for those observations.
 */
export const startupResourceBudget = Object.freeze({ javascript: 3_700_000, css: 700_000, gzip: 1_200_000 });
export const startupJavaScriptChunkBudget = 120;
export const requiredStartupModule = /\/(?:apps\/workbench-web\/src\/(?:workbench-entry|main)\.tsx?|plugins\/(?:builtin-agents|headless-model-services)\/src\/runtime-entry\.tsx?|plugins\/builtin-agents\/src\/index\.tsx?)$/;
/** Trusted build owners may add roots and exclusions without relaxing core limits. */
export interface StartupResourcePolicy {
  readonly requiredModules?: readonly RegExp[];
  readonly demandOnlyModules?: readonly RegExp[];
}
const demandOnlyPatterns = [
  /\/apps\/workbench-web\/src\/components\/modal\/adaptive-sheet-handle\.tsx$/,
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
