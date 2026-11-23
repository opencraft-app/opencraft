import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Touch presentation and current input modality have one owner each, projected
// through `@opencraft/design-system-web/input-presentation`. Product code must
// not re-derive either from pointer/hover media queries, touch points or the
// raw DOM projection. See design/ui/implementation-rules.md.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONTRACT = "packages/design-system-web/src/input-presentation.ts";
const PROJECTION_ATTRIBUTES = new Set(["data-ui-density", "data-touch-interaction"]);
const PROJECTION_DATASET = new Set(["uiDensity", "touchInteraction"]);
const POINTER_MEDIA_FEATURE = /\(\s*(?:any-)?(?:pointer|hover)\s*:/u;
const MEDIA_QUERY_STRING = /^\s*(?:(?:not|only)\s+)?(?:\(|(?:all|screen)\b)[^{}]*$/u;

/**
 * Raw touch-point probes that describe something other than local
 * presentation. Each entry must still match, so a stale exemption fails.
 */
export const TOUCH_POINT_EXEMPTIONS = new Map([
  ["apps/workbench-web/src/browser/remote-browser-device.ts", "describes the client device a remote browser emulates"],
  [
    "apps/workbench-web/src/timeline-viewport.ts",
    "feeds WebKit viewport engine detection (iPadOS reports a Mac platform)",
  ],
  ["packages/timeline-host-web/src/viewport.ts", "WebKit viewport engine detection (iPadOS reports a Mac platform)"],
  ["apps/workbench-web/src/runtime/recovery-diagnostics.ts", "records device facts in diagnostics only"],
]);

function line(ast, node) {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${}");
  return null;
}

/** Returns policy violations and whether a touch-point probe was seen. */
export function inspectTouchPresentationSource(source, file) {
  const issues = [];
  let touchPoints = false;
  if (file === CONTRACT) return { issues, touchPoints };
  if (
    !/pointer|hover|maxTouchPoints|ontouchstart|uiDensity|touchInteraction|data-ui-density|data-touch-interaction/u.test(
      source,
    )
  )
    return { issues, touchPoints };
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const report = (node, message) => issues.push({ file, line: line(ast, node), message });
  function visit(node) {
    // A media query may reach matchMedia through a constant or a local
    // wrapper, so every script-level query string is inspected, not only
    // direct call arguments. CSS text (`@media(...){...}`) is not a query.
    const query = literalText(node);
    if (query !== null && MEDIA_QUERY_STRING.test(query) && POINTER_MEDIA_FEATURE.test(query)) {
      report(
        node,
        "Consume isTouchPresentation/isTouchInteraction from @opencraft/design-system-web/input-presentation instead of querying pointer/hover media",
      );
    }
    if (
      (ts.isPropertyAccessExpression(node) &&
        ["maxTouchPoints", "msMaxTouchPoints", "ontouchstart"].includes(node.name.text)) ||
      ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "ontouchstart")
    ) {
      touchPoints = true;
      if (!TOUCH_POINT_EXEMPTIONS.has(file))
        report(node, "Touch-point probes do not decide presentation; consume the input-presentation contract");
    }
    const datasetKey = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node)
        ? literalText(node.argumentExpression)
        : null;
    if (
      datasetKey !== null &&
      PROJECTION_DATASET.has(datasetKey) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "dataset"
    ) {
      report(node, "Read or write the touch projection through @opencraft/design-system-web/input-presentation");
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      PROJECTION_ATTRIBUTES.has(node.text)
    ) {
      report(
        node,
        "Use the input-presentation attribute constants and readers instead of the raw projection attribute",
      );
    }
    if (ts.isJsxAttribute(node) && PROJECTION_ATTRIBUTES.has(node.name.getText(ast))) {
      report(node, "Only the host projects touch presentation and modality onto the document");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { issues, touchPoints };
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ["node_modules", "dist", "build", "tests", "__tests__", "fixtures", ".git", "generated", "vendor"].includes(
        entry.name,
      )
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (
      /\.(?:tsx?|jsx|mjs|js)$/u.test(entry.name) &&
      !/\.(?:test|spec)\./u.test(entry.name) &&
      !/\.d\.ts$/u.test(entry.name)
    )
      result.push(path);
  }
  return result;
}

async function main() {
  const paths = (
    await Promise.all(["apps/workbench-web/src", "packages", "plugins"].map((path) => files(resolve(root, path))))
  ).flat();
  const issues = [];
  const usedExemptions = new Set();
  for (const path of paths) {
    const file = relative(root, path);
    const result = inspectTouchPresentationSource(await readFile(path, "utf8"), file);
    issues.push(...result.issues);
    if (result.touchPoints && TOUCH_POINT_EXEMPTIONS.has(file)) usedExemptions.add(file);
  }
  for (const file of TOUCH_POINT_EXEMPTIONS.keys()) {
    if (!usedExemptions.has(file))
      issues.push({
        file,
        line: 1,
        message: "Stale touch-point exemption; remove it from check-touch-presentation.mjs",
      });
  }
  for (const issue of issues) console.error(`${issue.file}:${issue.line}: ${issue.message}`);
  console.log(`Touch presentation policy: ${paths.length} source files, ${issues.length} violations`);
  if (issues.length) process.exitCode = 1;
}
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))
)
  await main();
