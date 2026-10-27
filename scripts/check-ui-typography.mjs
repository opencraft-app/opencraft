import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { pathToFileURL } from "node:url";
import scss from "postcss-scss";
import ts from "typescript";

export const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(readFileSync(resolve(root, "packages/design-system/src/typography/typography.tokens.json"), "utf8"));
const kebab = value => value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const roleNames = new Set(Object.keys(registry.platforms.web.roles).map(kebab));
const knownVariables = new Set([
  ...[...roleNames].flatMap(name => ["font", "family", "size", "weight", "line-height", "tracking", "leading"].map(part => `--typography-${name}-${part}`)),
  ...Object.keys(registry.families).map(name => `--font-family-${name}`),
  ...Object.keys(registry.weights).map(name => `--font-weight-${name}`),
  ...Object.keys(registry.tracking).map(name => `--font-tracking-${name}`),
  ...["lg", "md", "sm", "xs", "2xs"].flatMap(name => ["size", "line-height"].map(part => `--font-text-${name}-${part}`)),
  "--opencraft-chat-font-size", "--opencraft-chat-code-font-size", "--opencraft-chat-line-height",
  "--opencraft-sidebar-font-size", "--opencraft-sidebar-line-height", "--opencraft-sidebar-meta-font-size", "--opencraft-sidebar-meta-line-height",
]);
const properties = new Set(["font", "font-family", "font-size", "font-weight", "line-height", "letter-spacing"]);
const camel = new Map([["fontFamily", "font-family"], ["fontSize", "font-size"], ["fontWeight", "font-weight"], ["lineHeight", "line-height"], ["letterSpacing", "letter-spacing"]]);
const inherited = /^(?:inherit|initial|unset|revert(?:-layer)?|normal|0)$/;

export function inspectStyle(source, file = "fixture.scss") {
  const findings = [];
  const tree = scss.parse(source, { from: file });
  tree.walkDecls(d => {
    const reservedDefinition = /^--(?:typography-|font-(?:family|size|weight|tracking|text|toolbar)|opencraft-chat-)/.test(d.prop);
    if (reservedDefinition && file !== "packages/design-system/src/tokens.web.scss") {
      findings.push({file, line:d.source.start.line, selector:"custom-property", property:d.prop, value:d.value}); return;
    }
    if (!properties.has(d.prop) || inherited.test(d.value)) return;
    // Refer only to the existing semantic owner; dimensions are not typography.
    const refs = d.value.match(/var\(--(?:typography-[\w-]+|font-(?:family|weight|tracking|text)[\w-]*|opencraft-(?:chat|sidebar)[\w-]*)\)/g);
    const rest = refs ? d.value.replace(/var\(--(?:typography-[\w-]+|font-(?:family|weight|tracking|text)[\w-]*|opencraft-(?:chat|sidebar)[\w-]*)\)/g, "").trim() : d.value;
    const invalidRole = [...d.value.matchAll(/var\((--[\w-]+)\)/g)].some(match => !knownVariables.has(match[1]));
    if (refs && (!rest || /^[\s/]+$/.test(rest)) && !invalidRole) return;
    let selector = "";
    for (let n = d.parent; n?.type !== "root"; n = n.parent) selector = `${n.selector ?? `@${n.name} ${n.params}`} ${selector}`.trim();
    findings.push({ file, line: d.source.start.line, selector, property: d.prop, value: d.value });
  });
  return findings;
}

export function inspectTypescript(source, file = "fixture.tsx") {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  const add = (node, property, value) => findings.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, selector: "typescript", property, value });
  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
      if (camel.has(name) || properties.has(name)) {
        const value = node.initializer;
        const text = value.getText(tree).replace(/^["'`]|["'`]$/g, "");
        const reference = /(?:typographyRole|nativeTypographyStyle|nativeMonoFontFamily|typographyRegistry|\btheme\.|\b(?:nativeTokens|tokens)\.|\bbutton(?:SizeMetrics|Typography)\b)/.test(text);
        const adapterProjection = file === "packages/design-system/src/typography/typography.shared.ts" && ["scale.fontSize", "scale.lineHeight", "String(registry.weights[definition.weight]) as TypographyFontWeight"].includes(text);
        let numericOverride = false;
        if (reference && ["fontSize", "lineHeight", "letterSpacing"].includes(name)) {
          const check = child => { if (ts.isNumericLiteral(child)) numericOverride = true; ts.forEachChild(child, check); };
          check(value);
        }
        if ((!inherited.test(text) && !reference && !adapterProjection) || numericOverride) add(node, camel.get(name) ?? name, text);
      }
    }
    // Owned JSX/Tailwind consumers cannot bypass the registry with utility fonts.
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === "className" && node.initializer) {
      const text = node.initializer.getText(tree);
      const utilities = text.match(/\b(?:font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|sans|serif|mono|\[[^\]]+\])|text-(?:xs|sm|base|lg|xl|[2-9]xl|\[[^\]]+\])|leading-(?:none|tight|snug|normal|relaxed|loose|\d+|\[[^\]]+\]))(?![\w-])/g);
      for (const value of utilities ?? []) add(node, "utility", value);
      for (const match of text.matchAll(/ui-text--([\w-]+)/g)) if (!roleNames.has(match[1])) add(node, "semantic-role", match[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

function filesIn(directory) {
  return readdirSync(directory).flatMap(name => {
    const file = resolve(directory, name);
    if (["node_modules", "upstream", "vendor", "generated", "dist", "build", ".expo"].includes(name)) return [];
    return statSync(file).isDirectory() ? filesIn(file) : [file];
  });
}
export function scanRepository(directory = root) {
  const findings = [];
  for (const file of ["apps", "packages", "plugins"].flatMap(name => filesIn(resolve(directory, name)))) {
    const name = relative(directory, file).replaceAll("\\", "/");
    if (!name.includes("/src/") || /(?:\.test\.|\.spec\.|\/__tests__\/|\/typography\/_generated\.web\.scss$)/.test(name)) continue;
    const source = readFileSync(file, "utf8");
    if ([".scss", ".css"].includes(extname(file))) findings.push(...inspectStyle(source, name));
    else if ([".ts", ".tsx"].includes(extname(file))) findings.push(...inspectTypescript(source, name));
  }
  return findings;
}

export function classify(findings, exceptions) {
  const used = new Set();
  const errors = findings.filter(f => {
    const index = exceptions.findIndex(e => e.file === f.file && e.selector === f.selector && e.property === f.property && e.value === f.value);
    if (index < 0) return true;
    used.add(index); return false;
  });
  const stale = exceptions.filter((_, i) => !used.has(i));
  return { errors, stale };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = scanRepository();
  if (process.argv.includes("--inventory")) { console.log(JSON.stringify(findings, null, 2)); }
  else {
    const policy = JSON.parse(readFileSync(resolve(root, "design/ui/typography-exceptions.json"), "utf8"));
    if (policy.version !== 1 || !Array.isArray(policy.exceptions) || policy.exceptions.some(e => !e.file || !e.selector || !e.property || !e.value || !e.owner || !e.reason || !e.reviewWhen || /[*]/.test(e.file))) throw new Error("Invalid typography exception: exact declaration, owner, reason and reviewWhen required");
    const keys = policy.exceptions.map(({file, selector, property, value}) => JSON.stringify([file, selector, property, value]));
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate typography exception");
    const { errors, stale } = classify(findings, policy.exceptions);
    for (const f of errors) console.error(`${f.file}:${f.line} ${f.selector} ${f.property}: ${f.value}`);
    for (const f of stale) console.error(`Stale typography exception: ${f.file} ${f.selector} ${f.property}: ${f.value}`);
    if (errors.length || stale.length) { console.error("Read design/ui/typography.md. Use the existing semantic role; exceptions require an owner and rationale, never regenerate a debt baseline."); process.exitCode = 1; }
    else console.log(`UI typography: all owned apps/packages/plugins checked; ${findings.length} registered specialist declarations.`);
  }
}
