import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import scss from "postcss-scss";

const root = resolve(import.meta.dirname, "..");
const localArtwork = new Set([
  "apps/workbench-web/src/chrome-actions/sidebar-toggle-icon.tsx",
  "apps/workbench-web/src/components/sidebar-bots.tsx",
  "plugins/bot-chat/src/bot-avatar.tsx",
  "plugins/bot-chat/src/bot-avatar-stage.tsx",
]);

/** Inspect imports as well as JSX so aliases and dynamic registries cannot evade coverage. */
export function inspectInterfaceIcons(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors = [];
  const fail = (node, reason) => errors.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1} ${reason}`);
  const sharedGlyphs = new Set();
  const toasters = new Set();
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) continue;
    for (const item of node.importClause.namedBindings.elements) {
      if (node.moduleSpecifier.text === "@opencraft/design-system-web/action-icons" || node.moduleSpecifier.text === "./action-icons") sharedGlyphs.add(item.name.text);
      if (node.moduleSpecifier.text === "sonner" && (item.propertyName?.text ?? item.name.text) === "Toaster") toasters.add(item.name.text);
    }
  }
  function containsGlyph(node) {
    return ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && sharedGlyphs.has(node.tagName.getText(ast)))
      || !!ts.forEachChild(node, containsGlyph);
  }
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      const attributes = node.attributes.properties;
      const hasAttribute = name => attributes.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === name);
      if (toasters.has(tag) && !hasAttribute("icons")) fail(node, "notification defaults must be mapped to shared SVG icons");
      if (tag === "select") {
        let shell = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent;
        while (shell && !ts.isJsxElement(shell) && !ts.isSourceFile(shell)) shell = shell.parent;
        if (!shell || !containsGlyph(shell)) fail(node, "native select arrows must use a shared SVG adapter");
      }
      if (tag === "summary") {
        const adapted = attributes.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "className"
          && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text.split(/\s+/u).includes("ui-native-disclosure"));
        if (!adapted && !containsGlyph(node.parent)) fail(node, "native disclosure markers must use shared SVG");
      }
    }
    // Keep keyboard legends and document text distinct from generated control artwork.
    if (ts.isJsxText(node) || ts.isStringLiteral(node)) {
      let parent = node.parent;
      let inJsx = ts.isJsxText(node);
      let keyboard = false;
      while (parent && !ts.isSourceFile(parent)) {
        if (ts.isJsxAttribute(parent)) break;
        if (ts.isJsxExpression(parent)) inJsx = true;
        if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(ast) === "kbd") keyboard = true;
        parent = parent.parent;
      }
      const text = node.text.trim();
      const numericPrefix = ts.isJsxText(node) && text === "−" && ts.isJsxElement(node.parent)
        && node.parent.children.some(child => ts.isJsxExpression(child));
      if (inJsx && !keyboard && !numericPrefix && (/^[⌄‹›☑☐▧↵‼↑↓−＋○]$/u.test(text) || /^‹\s|\s→$/u.test(text))) {
        fail(node, "generated control glyphs must use shared SVG, not font characters");
      }
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && ["lucide-react", "lucide-react-native"].includes(node.moduleSpecifier?.text)) {
      fail(node, "interface glyphs must use the shared platform action-icons owner");
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === "svg"
      && !file.startsWith("packages/design-system-web/") && !localArtwork.has(file)) {
      fail(node, "interface artwork belongs in the shared SVG package; content/brand exceptions must be explicit");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}

/** Inspect drawing declarations, rather than treating every decorative border as an icon. */
export function inspectInterfaceIconStyles(source, file) {
  const errors = [];
  const tree = scss.parse(source, { from: file });
  tree.walkRules(rule => {
    const declarations = (rule.nodes ?? []).filter(node => node.type === "decl");
    const has = expression => declarations.some(d => expression.test(`${d.prop}:${d.value}`));
    const spinner = has(/^border(?:-width)?:.*(?:solid|[\d.]+px)/u)
      && has(/^border-(?:top|right|bottom|left)-color:/u)
      && has(/^animation(?:-name)?:/u);
    const pseudoArtwork = /(?:icon|glyph|__copy|__check)[\w-]*::(?:before|after)/u.test(rule.selector)
      && has(/^content:["']{2}$/u) && has(/^border(?:-width)?:/u);
    if (spinner || pseudoArtwork) errors.push(`${file}:${rule.source.start.line} CSS-drawn interface artwork must use shared SVG (${rule.selector})`);
  });
  return errors;
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", "dist", "__tests__"].includes(entry.name)) return [];
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(?:[jt]sx?|s?css)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directories = process.argv.slice(2);
  const files = (directories.length ? directories : ["apps/workbench-web/src", "apps/workbench-expo/src", "packages", "plugins"]).flatMap(directory => sources(resolve(root, directory)));
  const errors = files.flatMap(file => /\.s?css$/.test(file)
    ? inspectInterfaceIconStyles(readFileSync(file, "utf8"), relative(root, file).replaceAll("\\", "/"))
    : inspectInterfaceIcons(readFileSync(file, "utf8"), relative(root, file).replaceAll("\\", "/")));
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`Interface icon ownership verified across ${files.length} source files (avatar artwork exceptions explicit).`);
}
