import { readFileSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(appRoot, "../..");

export function resolveDesktopProductEntries(environment = process.env) {
  const names = ["OPENCRAFT_DESKTOP_PRODUCT_MAIN_ENTRY", "OPENCRAFT_DESKTOP_PRODUCT_PRELOAD_ENTRY", "OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_ENTRY"];
  const selected = names.map(name => environment[name]?.trim());
  if (selected.some(Boolean) && !selected.every(Boolean)) throw new Error("Desktop product requires Main, Preload and Identity entries");
  return selected.map((entry, i) => {
    if (!entry) return resolve(appRoot, ["src/desktop-product-main-entry.ts", "src/desktop-product-preload-entry.ts", "src/desktop-product-identity-entry.ts"][i]);
    if ((!isAbsolute(entry) && /^[a-z][a-z\d+.-]*:/iu.test(entry)) || !/\.[cm]?[jt]s$/u.test(entry)) throw new Error(`${names[i]} requires a local JavaScript or TypeScript file`);
    const file = resolve(root, entry);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${names[i]} does not name an existing file`);
    return file;
  });
}

export function resolveDesktopIdentityConfig(environment = process.env) {
  const configured = environment.OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_CONFIG?.trim();
  const selected = environment.OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_ENTRY?.trim();
  if (selected && !configured) throw new Error("Desktop product identity entry requires OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_CONFIG");
  if (!selected && configured) throw new Error("Desktop identity config requires a product identity entry");
  const file = configured ? resolve(root, configured) : resolve(appRoot, "src/product-identity.json");
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("Desktop identity config must be a local file");
  const value = JSON.parse(readFileSync(file, "utf8"));
  for (const kind of ["production", "preview"]) {
    const identity = value[kind];
    if (!identity || typeof identity.displayName !== "string" || !identity.displayName
      || typeof identity.applicationId !== "string" || !/^[A-Za-z][A-Za-z0-9.-]+$/u.test(identity.applicationId)
      || (kind === "production" && (typeof identity.speechHelperId !== "string" || !/^[A-Za-z][A-Za-z0-9.-]+$/u.test(identity.speechHelperId)))) {
      throw new Error(`Desktop identity config has invalid ${kind} identity`);
    }
  }
  return value;
}

/** Pure JS bundling only; native helpers and daemon remain owned by build:host. */
export async function bundleDesktopHost({ environment = process.env, outdir = resolve(appRoot, "dist-host") } = {}) {
  const [mainEntry, preloadEntry, identityEntry] = resolveDesktopProductEntries(environment);
  const identities = resolveDesktopIdentityConfig(environment);
  const manifestPath = resolve(outdir, "desktop-identity.json");
  await rm(manifestPath, { force: true });
  const shared = { absWorkingDir: root, nodePaths: [resolve(root, "node_modules")], bundle: true,
    platform: "node", format: "cjs", external: ["electron"], metafile: true,
    plugins: [{ name: "desktop-product-composition", setup(builder) {
      builder.onResolve({ filter: /^\.\/desktop-product-(main|preload|identity)-entry\.js$/ }, args => ({
        path: args.path.includes("-main-") ? mainEntry : args.path.includes("-preload-") ? preloadEntry : identityEntry,
      }));
    } }],
  };
  const main = await build({ ...shared, entryPoints: [resolve(appRoot, "src/main.ts")], outfile: resolve(outdir, "main.cjs"),
    define: { "import.meta.url": "import_meta_url" }, banner: { js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;" } });
  const preload = await build({ ...shared, entryPoints: [resolve(appRoot, "src/preload.ts")], outfile: resolve(outdir, "preload.cjs") });
  const mainSha256 = createHash("sha256").update(await readFile(resolve(outdir, "main.cjs"))).digest("hex");
  await writeFile(manifestPath, JSON.stringify({ ...identities, mainSha256 }, null, 2) + "\n");
  return { main, preload };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundleDesktopHost();
