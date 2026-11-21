import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

const visibleAttributes = new Set([
  "title", "aria-label", "aria-description", "placeholder", "alt", "label",
  "description", "emptyMessage", "accessibilityLabel", "accessibilityHint",
]);
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const hasCopy = text => /\p{L}{2}/u.test(text);

/** Syntax coverage, not whole-program data flow or a translation-completeness claim. */
export function inspectSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const messages = [], copy = [];
  const add = (node, kind, value) => {
    const text = value.replace(/\s+/gu, " ").trim();
    if (hasCopy(text)) copy.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind, text });
  };
  function rendered(node, kind) {
    if (!node) return;
    const value = literal(node);
    if (value !== undefined) { add(node, kind, value); return; }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) rendered(node.expression, kind);
    else if (ts.isConditionalExpression(node)) { rendered(node.whenTrue, kind); rendered(node.whenFalse, kind); }
    else if (ts.isBinaryExpression(node)) {
      // The left of && is a condition, not display copy. Both ||/?? sides can render.
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) rendered(node.left, kind);
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) rendered(node.right, kind);
    } else if (ts.isTemplateExpression(node)) {
      add(node, kind, node.head.text + node.templateSpans.map(span => "${…}" + span.literal.text).join(""));
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(item => rendered(item, kind));
    // Calls, identifiers, object fields and callbacks need owner review. Do not
    // mistake formatMessage defaults, event handler code or protocol IDs for UI.
  }
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(source).replace(/^["']|["']$/gu, ""), literal(p.initializer)]));
      if (fields.id && fields.defaultMessage) messages.push({ id: fields.id, defaultMessage: fields.defaultMessage, ...(fields.description ? { description: fields.description } : {}), source: file });
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(source).split(".").at(-1) === "FormattedMessage") {
        const fields = Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(p => [p.name.getText(source), literal(ts.isJsxExpression(p.initializer ?? {}) ? p.initializer.expression : p.initializer)]));
        if (fields.id && fields.defaultMessage) messages.push({ id: fields.id, defaultMessage: fields.defaultMessage, ...(fields.description ? { description: fields.description } : {}), source: file });
      }
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !visibleAttributes.has(attribute.name.getText(source))) continue;
        const value = attribute.initializer;
        rendered(value && ts.isJsxExpression(value) ? value.expression : value, attribute.name.getText(source));
      }
    }
    if (ts.isJsxText(node)) add(node, "jsx-text", node.text);
    if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) rendered(node.expression, "jsx-expression");
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { messages, copy };
}

export async function scanProject(root) {
  const messages = [], copy = [], files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (["node_modules", "dist", "locales", "__tests__", "fixtures"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.[cm]?tsx?$/u.test(path) && !/\.(?:test|spec)\.[cm]?tsx?$/u.test(path)) {
        const file = relative(root, path).split("\\").join("/");
        const result = inspectSource(file, await readFile(path, "utf8"));
        files.push(file); messages.push(...result.messages); copy.push(...result.copy);
      }
    }
  }
  for (const area of ["apps", "packages", "plugins"]) {
    for (const workspace of (await readdir(join(root, area), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!workspace.isDirectory()) continue;
      const path = join(root, area, workspace.name, "src");
      // A workspace may have no src; IO failures inside existing src must surface.
      try { await readdir(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      await walk(path);
    }
  }
  return { files, messages, copy };
}

export function copyKey({ file, kind, text }) { return JSON.stringify([file, kind, text]); }

export function compareCopy(copy, baseline) {
  const allowed = new Map(), actual = new Map(), errors = [];
  for (const row of baseline.entries) {
    const key = copyKey(row);
    if (!Number.isInteger(row.count) || row.count < 1 || !(row.reason ?? baseline.reason)?.trim() || allowed.has(key)) throw new Error(`Invalid i18n baseline entry: ${key}`);
    allowed.set(key, row.count);
  }
  for (const row of copy) {
    const key = copyKey(row), count = (actual.get(key) ?? 0) + 1;
    actual.set(key, count);
    if (count > (allowed.get(key) ?? 0)) errors.push(`${row.file}:${row.line}: untranslated ${row.kind}: ${row.text}`);
  }
  for (const [key, count] of allowed) {
    if ((actual.get(key) ?? 0) < count) errors.push(`Remove obsolete i18n baseline allowance: ${key}`);
  }
  return errors;
}
