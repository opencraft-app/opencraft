import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import scss from "postcss-scss";
import selectorParser from "postcss-selector-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protectedClass = /^(?:ui-button(?:__.*)?|ui-disclosure-button|ui-control-surface|ui-navigation-(?:list|group|item)|chrome-button|settings-control-button|sidebar-new-chat|shell-navigation__entrance)$/u;
const forbiddenPaint = /^(?:background(?:-.+)?|(?:-webkit-)?backdrop-filter|box-shadow|border(?:-.+)?|color|appearance|cursor|height|min-height|padding(?:-.+)?)$/u;
const owner = path => path.startsWith("packages/design-system-web/src/") || path.startsWith("packages/design-system/src/");

/** Parse source and selectors so formatting, aliases and conditional classes
 * cannot turn an ownership rule into an opt-out. Returns actionable locations. */
export function sharedControlClassNames(path, source) {
  if (!/\.[cm]?[jt]sx?$/u.test(path) || owner(path)) return [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // A group owns material, while its Shell/feature container still owns the box.
  const names = new Set(["Button", "DisclosureButton", "IconButton", "ButtonPlaceholder", "SettingsButton", "SettingsIconButton", "NavigationList", "NavigationGroup", "NavigationItem"]);
  const result = new Set();
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const binding of node.importClause.namedBindings.elements) if (names.has((binding.propertyName ?? binding.name).text)) names.add(binding.name.text);
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && names.has(node.tagName.getText(tree))) {
      for (const a of node.attributes.properties) if (ts.isJsxAttribute(a) && a.name.getText(tree) === "className" && a.initializer) {
        function collect(n) {
          if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
            for (const value of n.text.split(/\s+/u)) if (/^[\w-]+$/u.test(value)) result.add(value);
          }
          ts.forEachChild(n, collect);
        }
        collect(a.initializer);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); return [...result];
}

export function controlOwnershipViolations(path, source, consumerClasses = new Set()) {
  if (owner(path)) return [];
  const errors = [];
  const report = (line, message) => errors.push(`${path}:${line}: ${message}`);
  if (/\.[cm]?[jt]sx?$/u.test(path)) {
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const line = node => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    const constants = new Map();
    const shared = new Set(["Button", "DisclosureButton", "IconButton", "ButtonPlaceholder", "ControlSurface", "SettingsButton", "SettingsIconButton", "NavigationList", "NavigationGroup", "NavigationItem"]);
    function index(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const binding of node.importClause.namedBindings.elements) {
          if (shared.has((binding.propertyName ?? binding.name).text)) shared.add(binding.name.text);
        }
      }
      ts.forEachChild(node, index);
    }
    index(tree);
    const strings = node => {
      const values = [];
      function collect(n, depth = 0) {
        if (depth > 12) return;
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) values.push(n.text);
        if (ts.isIdentifier(n) && constants.has(n.text)) collect(constants.get(n.text), depth + 1);
        ts.forEachChild(n, child => collect(child, depth + 1));
      }
      collect(node); return values;
    };
    function visit(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /(?:^|\/)liquid-glass(?:\.[^/]*)?$/u.test(node.moduleSpecifier.text)) {
        report(line(node), "Use Button or ControlSurface; their owner creates the material backdrop.");
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(tree);
        const raw = ["button", "span", "div", "nav"].includes(tag);
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const name = attribute.name.getText(tree);
          if (["data-liquid-action", "data-control-surface", "data-content-layout", "data-control-loading"].includes(name)) {
            report(line(attribute), "Control projection attributes belong to the design system; pass semantic props.");
          }
          if (raw && name === "className" && attribute.initializer) {
            if (strings(attribute.initializer).some(value => value.split(/\s+/u).some(token => protectedClass.test(token)))) {
              report(line(attribute), "Use a shared control or navigation primitive instead of raw shared-control markup.");
            }
          }
          if (shared.has(tag) && name === "style" && attribute.initializer) {
            function inspect(n) {
              if (ts.isPropertyAssignment(n)) {
                const property = n.name.getText(tree).replace(/["']/gu, "").replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`);
                if (forbiddenPaint.test(property)) report(line(n), `Inline '${property}' bypasses the shared control owner; select a semantic variant.`);
              }
              ts.forEachChild(n, inspect);
            }
            inspect(attribute.initializer);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  } else if (/\.(?:s?css)$/u.test(path)) {
    let tree;
    try { tree = scss.parse(source, { from: path }); }
    catch (error) { return [`${path}: invalid stylesheet: ${error.message}`]; }
    tree.walkRules(rule => {
      if (rule.selector.includes("data-liquid-action")) report(rule.source.start.line, "Global material opt-ins are forbidden; use explicit control surfaces.");
      let controls = false;
      try {
        function expandedSelector(node) {
          let selector = node.selector;
          let parent = node.parent;
          while (parent && parent.type !== "rule") parent = parent.parent;
          if (selector.includes("&") && parent) selector = selector.replaceAll("&", `:is(${expandedSelector(parent)})`);
          return selector;
        }
        selectorParser(selectors => {
          const positiveTarget = node => {
            let current = node;
            while (current.parent) {
              if (current.parent.type === "pseudo" && [":not", ":has"].includes(current.parent.value)) return false;
              if (current.parent.type === "selector" && current.parent.nodes.slice(current.parent.nodes.indexOf(current) + 1).some(n => n.type === "combinator")) return false;
              current = current.parent;
            }
            return true;
          };
          selectors.walkAttributes(a => { if (["data-control-surface", "data-content-layout", "data-control-loading"].includes(a.attribute) && positiveTarget(a)) controls = true; });
          selectors.walkClasses(c => { if ((protectedClass.test(c.value) || consumerClasses.has(c.value)) && positiveTarget(c)) controls = true; });
        }).processSync(expandedSelector(rule));
      } catch { return; } // Sass interpolation is checked at its concrete owners.
      if (!controls) return;
      rule.each(node => {
        if (node.type === "decl" && forbiddenPaint.test(node.prop)) report(node.source.start.line, `Shared control '${node.prop}' belongs to the design system; select a semantic variant.`);
        if (node.type === "atrule" && node.name === "include" && /(?:navigation-control|sidebar-entrance|quiet-control|compact-action)/u.test(node.params)) report(node.source.start.line, "Shared controls already own interaction and geometry; remove the duplicate control mixin.");
      });
    });
    tree.walkAtRules("include", rule => {
      if (/\b\w+\.liquid(?:\s|\(|$)/u.test(rule.params)) report(rule.source.start.line, "Liquid control material belongs to the shared surface owner.");
    });
  }
  return errors;
}

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "dist-host", "build", ".git", ".expo"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(?:[cm]?[jt]sx?|s?css)$/u.test(path)) yield path;
  }
}

export async function checkControlOwnership(base = root) {
  const errors = [];
  const sources = [];
  for (const directory of ["apps", "packages", "plugins"]) {
    for (const workspace of await readdir(join(base, directory), { withFileTypes: true })) {
      if (!workspace.isDirectory() || workspace.name.startsWith(".")) continue;
      for (const source of ["src", "app"]) {
        const sourceRoot = join(base, directory, workspace.name, source);
        try {
          for await (const path of files(sourceRoot)) {
            sources.push([relative(base, path).replaceAll("\\", "/"), await readFile(path, "utf8")]);
          }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }
  const consumers = new Set(sources.flatMap(([path, source]) => sharedControlClassNames(path, source)));
  for (const [path, source] of sources) errors.push(...controlOwnershipViolations(path, source, consumers));
  return errors;
}

if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  const errors = await checkControlOwnership();
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Shared control ownership checks passed.");
}
