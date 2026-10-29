import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import scss from "postcss-scss";
import selectorParser from "postcss-selector-parser";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const persistentAttribute = /^(?:data-(?:state|highlighted|selected|active|open|resizing)|aria-(?:current|selected|pressed))$/u;
const empty = () => ({ hover: false, persistent: false, input: false });
const merge = (a, b) => ({ hover: a.hover || b.hover, persistent: a.persistent || b.persistent, input: a.input || b.input });
function product(left, right) {
  // Bound selector expansion; unsupported complexity must fail, never silently pass.
  if (left.length * right.length > 256) throw new Error("Split complex hover selectors into explicit branches");
  return left.flatMap(a => right.map(b => merge(a, b)));
}
function selectorFacts(selector) {
  const ast = selectorParser().astSync(selector);
  function facts(node) {
    if (node.type === "root") return node.nodes.flatMap(facts);
    if (node.type === "selector") {
      let result = [empty()];
      for (const child of node.nodes) result = product(result, facts(child));
      return result;
    }
    if (node.type === "pseudo") {
      if (node.value === ":not") {
        // A document guard is a root compound, not a guard on a descendant or
        // a string hidden in an attribute/another selector alternative.
        if (node.nodes?.some(branch => branch.toString().includes(":not(") && /:hover\b/u.test(branch.toString()))) throw new Error("Split nested hover negation into explicit branches");
        const attribute = node.nodes?.[0]?.nodes?.[0];
        const previous = node.prev();
        const input = previous?.type === "pseudo" && previous.value === ":root" &&
          node.nodes.length === 1 && node.nodes[0].nodes.length === 1 &&
          attribute.type === "attribute" && attribute.attribute === "data-touch-interaction" &&
          (!attribute.operator || (attribute.operator === "=" && attribute.value === "true"));
        return [{ ...empty(), input }];
      }
      if ([":is", ":where", ":has"].includes(node.value)) return node.nodes.flatMap(facts);
      if (node.nodes?.length && /:hover\b/u.test(node.toString())) throw new Error("Use explicit hover branches instead of unsupported functional selectors");
      return [{ ...empty(), hover: node.value === ":hover", persistent: node.value.startsWith(":focus") }];
    }
    return [{ ...empty(), persistent: node.type === "attribute" ? persistentAttribute.test(node.attribute) : node.type === "class" && /^is-(?:selected|active|open)$/u.test(node.value) }];
  }
  return facts(ast);
}
function capableMedia(node) {
  if (node.type !== "atrule" || node.name !== "media") return false;
  // Accept only explicit AND capability branches. OR inside a feature, negation
  // or a second unguarded query cannot borrow a guard from another branch.
  return node.params.split(",").every(branch => {
    const parts = branch.trim().split(/\s+and\s+/iu).map(part => part.replace(/\s/gu, "").toLowerCase());
    return parts.length === 2 && parts.some(part => /^\((?:any-)?hover:hover\)$/u.test(part)) && parts.some(part => /^\((?:any-)?pointer:fine\)$/u.test(part));
  });
}
export function inspectHoverStyles(source, file) {
  const issues = [];
  const ast = scss.parse(source, { from: file });
  ast.walkRules(rule => {
    const ancestors = [];
    for (let node = rule.parent; node && node.type !== "root"; node = node.parent) ancestors.push(node);
    const gate = ancestors.find(node => node.type === "atrule" && node.name === "include" && /^(?:[\w-]+\.)?hover-capable$/u.test(node.params));
    const media = ancestors.some(capableMedia);
    if (!gate && !media && !/:hover\b/u.test(rule.selector + ancestors.filter(node => node.type === "rule").map(node => node.selector).join(" "))) return;
    let facts;
    try {
      facts = selectorFacts(rule.selector);
      for (const parent of ancestors.filter(node => node.type === "rule")) facts = product(facts, selectorFacts(parent.selector));
    } catch (error) {
      issues.push({ file, line: rule.source.start.line, message: error.message, selector: rule.selector });
      return;
    }
    if (facts.some(branch => branch.hover && !gate && !(media && branch.input))) issues.push({ file, line: rule.source.start.line, message: "Transient hover must use controls.hover-capable (or both capability and document input guards on every branch).", selector: rule.selector });
    const coupled = gate?.prev()?.type === "comment" && gate.prev().text.startsWith("hover-policy: coupled-visibility — ");
    if (!coupled && (gate || media) && facts.some(branch => branch.persistent && !branch.hover)) issues.push({ file, line: rule.source.start.line, message: "Keep keyboard/open/selected branches outside the hover gate.", selector: rule.selector });
  });
  return issues;
}

function unwrap(node) {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function property(node, parameter, name) {
  node = unwrap(node);
  return node && ts.isPropertyAccessExpression(node) && node.name.text === name && ts.isIdentifier(node.expression) && node.expression.text === parameter;
}
function literalMouse(node) { node = unwrap(node); return node && ts.isStringLiteral(node) && node.text === "mouse"; }
function mouseComparison(node, parameter) {
  if (!ts.isBinaryExpression(node)) return undefined;
  const compared = property(node.left, parameter, "pointerType") && literalMouse(node.right) || property(node.right, parameter, "pointerType") && literalMouse(node.left);
  if (!compared) return undefined;
  if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return true;
}
function unownedPointerComparison(node, parameter) {
  if (ts.isBinaryExpression(node)) {
    const other = property(node.left, parameter, "pointerId") ? unwrap(node.right) : property(node.right, parameter, "pointerId") ? unwrap(node.left) : null;
    if (other && ts.isPropertyAccessExpression(other) && other.name.text === "pointerId" && !property(other, parameter, "pointerId")) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
      if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return true;
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["has", "hasPointerCapture"].includes(node.expression.name.text) && node.arguments.length === 1 && property(node.arguments[0], parameter, "pointerId")) return false;
}
function condition(node, parameter, compare) {
  node = unwrap(node);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = condition(node.operand, parameter, compare); return value === undefined ? undefined : !value;
  }
  if (ts.isBinaryExpression(node)) {
    const left = condition(node.left, parameter, compare), right = condition(node.right, parameter, compare);
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return left === true || right === true ? true : left === false && right === false ? false : undefined;
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return left === false || right === false ? false : left === true && right === true ? true : undefined;
  }
  return compare(node, parameter);
}
function pure(node, allowedCall = () => false) {
  let valid = true;
  function visit(child) {
    if (ts.isCallExpression(child) && !allowedCall(child) || ts.isNewExpression(child) || ts.isAwaitExpression(child) || ts.isPostfixUnaryExpression(child) || ts.isPrefixUnaryExpression(child) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(child.operator) || ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) valid = false;
    ts.forEachChild(child, visit);
  }
  visit(node); return valid;
}
// Interpret only a bounded, explicit guard shape. Calls/writes/returns on an
// unadmitted path fail; merely mentioning pointerType never establishes safety.
function guardedBody(fn, compare) {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.length === 0 || !ts.isIdentifier(fn.parameters[0].name)) return false;
  const parameter = fn.parameters[0].name.text;
  function run(statement) {
    if (ts.isBlock(statement)) {
      for (const child of statement.statements) { const result = run(child); if (!result.safe || result.ends) return result; }
      return { safe: true, ends: false };
    }
    if (ts.isEmptyStatement(statement)) return { safe: true, ends: false };
    if (ts.isReturnStatement(statement)) return { safe: !statement.expression, ends: true };
    if (ts.isVariableStatement(statement)) return { safe: statement.declarationList.declarations.every(d => !d.initializer || pure(d.initializer)), ends: false };
    if (ts.isIfStatement(statement)) {
      if (!pure(statement.expression, call => compare === unownedPointerComparison && compare(call, parameter) !== undefined)) return { safe: false, ends: false };
      const value = condition(statement.expression, parameter, compare);
      if (value !== undefined) return value ? run(statement.thenStatement) : statement.elseStatement ? run(statement.elseStatement) : { safe: true, ends: false };
      const yes = run(statement.thenStatement), no = statement.elseStatement ? run(statement.elseStatement) : { safe: true, ends: false };
      return { safe: yes.safe && no.safe, ends: yes.ends && no.ends };
    }
    return { safe: false, ends: false };
  }
  return run(fn.body).safe;
}
export function inspectHoverHandlers(source, file) {
  if (!/on(?:Mouse|Pointer)(?:Enter|Over|Move)/u.test(source)) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const issues = [];
  function visit(node) {
    if (ts.isJsxAttribute(node) && /^on(?:Mouse|Pointer)(?:Enter|Over|Move)$/u.test(node.name.getText(ast))) {
      const name = node.name.getText(ast), attributes = node.parent.properties;
      const expression = node.initializer && ts.isJsxExpression(node.initializer) ? unwrap(node.initializer.expression) : null;
      const portal = node.parent.parent.tagName?.getText(ast)?.endsWith(".Content");
      const continuity = portal && expression && ts.isIdentifier(expression) && ["cancelDismiss", "cancelClose"].includes(expression.text);
      const inline = expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression));
      const gestureOwner = name === "onPointerMove" && attributes.some(a => ts.isJsxAttribute(a) && a.name.getText(ast) === "onPointerDown") && attributes.some(a => ts.isJsxAttribute(a) && /^onPointer(?:Up|Cancel)$/u.test(a.name.getText(ast))) && inline && guardedBody(expression, unownedPointerComparison);
      if (!continuity && !gestureOwner && !(name.startsWith("onPointer") && inline && guardedBody(expression, mouseComparison))) issues.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, message: "Hover entry must guard mouse input before effects; pointer movement gestures need a matching pointer owner." });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); return issues;
}
export function inspectHoverSource(source, file) {
  if (/\.(?:css|scss)$/u.test(file)) return inspectHoverStyles(source, file);
  const issues = inspectHoverHandlers(source, file);
  for (const match of source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/giu)) {
    const offset = source.slice(0, match.index + match[0].indexOf(match[1])).split("\n").length - 1;
    issues.push(...inspectHoverStyles(match[1], file).map(issue => ({ ...issue, line: issue.line + offset })));
  }
  return issues;
}
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", "tests", "__tests__", "fixtures", ".git", "generated", "vendor"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(?:scss|css|tsx|ts|jsx|js|mjs|html)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)) result.push(path);
  }
  return result;
}
async function main() {
  const paths = [...new Set((await Promise.all(["apps/workbench-web/src", "apps/relay-server/src", "packages", "plugins", ...process.argv.slice(2)].map(path => files(resolve(root, path))))).flat())];
  const issues = [];
  for (const path of paths) issues.push(...inspectHoverSource(await readFile(path, "utf8"), relative(root, path)));
  for (const issue of issues) console.error(`${issue.file}:${issue.line}: ${issue.message}${issue.selector ? ` ${issue.selector.replace(/\s+/gu, " ")}` : ""}`);
  console.log(`Hover policy: ${paths.length} source files, ${issues.length} violations`);
  if (issues.length) process.exitCode = 1;
}
if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) await main();
