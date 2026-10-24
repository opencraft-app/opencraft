import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { pathToFileURL } from "node:url";
import scss from "postcss-scss";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
export const visualOwner = "apps/workbench-web/src/styles/_conversation-activity.scss";
const railOwner = "apps/workbench-web/src/components/conversation-renderers/activity/activity-icon.tsx";

// Complement generic typography lint: a valid token can still be the wrong
// semantic role, and SVG dimensions/strokes are not font declarations.
export function inspectActivityStyle(source, file = "fixture.scss") {
  const errors = [];
  const selectors = node => {
    let selector = "";
    for (let p = node.parent; p && p.type !== "root"; p = p.parent) selector = `${p.selector ?? ""} ${selector}`;
    return selector;
  };
  const summarySelector = /thread-(?:activity-item__(?:header|summary)\b|compaction\b|thinking-placeholder\b|subagent-activity__(?:toggle|status)\b|tool-row\b)/;
  const tree = scss.parse(source);
  tree.walkDecls(decl => {
    const selector = selectors(decl);
    const glyph = /thread-activity-item__icon\b/.test(selector)
      || /thread-(?:compaction|activity-item__header)\b.*(?:svg|img|lucide)/.test(selector);
    const summary = summarySelector.test(selector);
    const metric = /^(?:font(?:-.+)?|line-height|letter-spacing)$/.test(decl.prop);
    const geometry = /^(?:width|height|(?:min|max)-(?:width|height)|stroke(?:-.+)?|transform|filter|zoom)$/.test(decl.prop);
    if (file !== visualOwner && ((summary && metric) || (glyph && (metric || geometry)))) {
      errors.push(`${file}:${decl.source.start.line} activity metrics belong to ${visualOwner}`);
    }
  });
  tree.walkAtRules("include", rule => {
    if (file !== visualOwner && summarySelector.test(selectors(rule))
      && /(?:^|\.)role\s*\(/.test(rule.params)) {
      errors.push(`${file}:${rule.source.start.line} activity typography role belongs to ${visualOwner}`);
    }
  });
  return errors;
}

export function inspectActivityJsx(source, file = "fixture.tsx") {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors = [];
  const add = node => errors.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} use the shared activity visual owner; no local icon metrics/rail`);
  const metricProps = new Set(["size", "width", "height", "strokeWidth", "style", "className"]);
  function checkGlyph(node) {
    if (ts.isJsxAttribute(node) && metricProps.has(node.name.getText(tree))) add(node);
    ts.forEachChild(node, checkGlyph);
  }
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "activityIcon" && node.body) checkGlyph(node.body);
    if (ts.isFunctionDeclaration(node) && ["SubagentBlock", "AggregatedSubagentActivity", "ThreadTool"].includes(node.name?.text)) {
      let rail = false;
      let header = false;
      const find = child => {
        if ((ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && ["ActivityIcon", "ActivityRowContent"].includes(child.tagName.getText(tree))) rail = true;
        if (ts.isJsxAttribute(child) && child.name.getText(tree) === "className" && child.initializer
          && /\bthread-activity-item__header\b/.test(child.initializer.getText(tree))) header = true;
        ts.forEachChild(child, find);
      };
      find(node);
      if (!rail || !header) add(node);
    }
    if (ts.isFunctionDeclaration(node) && ["ActivityDisclosure", "ActivitySummaryRow", "AgentActivityGroupDisclosure", "ThreadTool"].includes(node.name?.text)) {
      let shared = false;
      const find = child => {
        if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
          const name = child.tagName.getText(tree);
          if (name === "ActivityRowContent") shared = true;
          if (name === "CadencedShimmer") add(child);
        }
        ts.forEachChild(child, find);
      };
      find(node);
      if (!shared) add(node);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "CompactionBlock") {
      let shared = false;
      const find = child => {
        if ((ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && child.tagName.getText(tree) === "ActivitySummaryRow") shared = true;
        ts.forEachChild(child, find);
      };
      find(node);
      if (!shared) add(node);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(tree);
      if (["ActivityDisclosure", "ActivitySummaryRow", "ActivityRowContent"].includes(name)) {
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr) && attr.name.getText(tree) === "icon" && attr.initializer) checkGlyph(attr.initializer);
        }
      }
      if (name === "ActivityIcon" && ts.isJsxElement(node.parent)) checkGlyphChildren(node.parent);
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.name.getText(tree) === "className" && attr.initializer
          && /\bthread-activity-item__icon\b/.test(attr.initializer.getText(tree)) && file !== railOwner) add(attr);
      }
    }
    ts.forEachChild(node, visit);
  }
  function checkGlyphChildren(node) { for (const child of node.children) checkGlyph(child); }
  visit(tree);
  return errors;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", "upstream", "vendor", "generated", "dist", "build", ".expo"].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
export function checkActivityRepository() {
  return ["apps", "packages", "plugins"].flatMap(dir => files(resolve(root, dir))).flatMap(path => {
    const file = relative(root, path).replaceAll("\\", "/");
    if (!file.includes("/src/") || /(?:\.test\.|\.spec\.|\/__tests__\/)/.test(file)) return [];
    const source = readFileSync(path, "utf8");
    if ([".scss", ".css"].includes(extname(path))) return inspectActivityStyle(source, file);
    if (extname(path) === ".tsx") return inspectActivityJsx(source, file);
    return [];
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkActivityRepository();
  errors.forEach(error => console.error(error));
  if (errors.length) { console.error("Read design/ui/activity-icons.md; preserve glyph identity and shared summary typography."); process.exitCode = 1; }
  else console.log("Conversation activity visual ownership checked across owned apps/packages/plugins.");
}
