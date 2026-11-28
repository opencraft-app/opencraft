import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageDir, "../..");
const defaultOutFile = path.join(repoRoot, "packages/design-system-web/vendor/valdi-web/valdi-web-bundle.mjs");

const valdiWorkspace = process.env.VALDI_WORKSPACE || "/private/tmp/chatgpt-android-analysis.lTRJRW8P/valdi-upstream";
if (!existsSync(valdiWorkspace)) {
  throw new Error(`Valdi checkout not found at ${valdiWorkspace}. Set VALDI_WORKSPACE.`);
}

const bazelBin =
  process.env.VALDI_BAZEL ||
  (existsSync("/private/tmp/valdi-toolchain/bin/bazel") ? "/private/tmp/valdi-toolchain/bin/bazel" : "bazel");

const [destination = defaultOutFile, ...extraBazelArgs] = process.argv.slice(2);
const outFile = path.resolve(destination);

const stageRel = "apps/opencraft_design_valdi";
const stageDir = path.join(valdiWorkspace, stageRel);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
for (const name of ["BUILD.bazel", "tsconfig.json", "src"]) {
  cpSync(path.join(packageDir, name), path.join(stageDir, name), { recursive: true });
}

const androidStub = "/tmp/opencraft-valdi-gallery/android-unused";
mkdirSync(androidStub, { recursive: true });
if (!existsSync(path.join(androidStub, "BUILD.bazel"))) {
  writeFileSync(path.join(androidStub, "REPO.bazel"), "");
  writeFileSync(path.join(androidStub, "BUILD.bazel"), "# unused Android SDK stub for Web/iOS builds\n");
}

execFileSync(
  bazelBin,
  [
    "build",
    `//${stageRel}:opencraft_valdi_web_npm`,
    "--snap_flavor=platform_development",
    "--define=enable_web=true",
    "--@valdi//bzl/valdi:assets_mode=inline",
    `--override_repository=rules_android++hermetic_android_sdk_extension+androidsdk=${androidStub}`,
    ...extraBazelArgs,
  ],
  { cwd: valdiWorkspace, stdio: "inherit" },
);

const bazelOutBin = path.join(valdiWorkspace, "bazel-bin");
const webPkgDir = path.join(bazelOutBin, stageRel, "opencraft_valdi_web_npm");
const apiVersionPath = path.join(bazelOutBin, stageRel, "opencraft_valdi_web_npm.valdi_api_version.json");
const valdiApiVersion = JSON.parse(readFileSync(apiVersionPath, "utf8").trim());
if (!Number.isSafeInteger(valdiApiVersion) || valdiApiVersion < 0) {
  throw new Error(`Invalid Valdi API version: ${String(valdiApiVersion)}`);
}

const scratch = mkdtempSync(path.join(tmpdir(), "opencraft-valdi-web-entry-"));
try {
  const pathShimFile = path.join(scratch, "path-browserify-shim.cjs");
  writeFileSync(
    pathShimFile,
    readFileSync(path.join(valdiWorkspace, "bzl/valdi/app_templates/web_path_browserify_shim.js.tpl"), "utf8"),
  );

  const indexSource = readFileSync(path.join(packageDir, "src/index.ts"), "utf8");
  const runtimeExportNames = [];
  for (const blockMatch of indexSource.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
    const specifiers = blockMatch[1].split(",");
    for (const rawSpec of specifiers) {
      const spec = rawSpec.trim();
      if (!spec || spec.startsWith("type ")) continue;
      const asParts = spec.split(/\s+as\s+/);
      const exportedName = (asParts[1] ?? asParts[0]).trim();
      if (exportedName && !runtimeExportNames.includes(exportedName)) {
        runtimeExportNames.push(exportedName);
      }
    }
  }

  const entryFile = path.join(scratch, "entry.mjs");
  writeFileSync(
    entryFile,
    [
      `import webRendererModule from ${JSON.stringify(path.join(webPkgDir, "src/web_renderer/src/ValdiWebRenderer.js"))};`,
      `import designModule from ${JSON.stringify(path.join(webPkgDir, "src/opencraft_design_valdi/src/index.js"))};`,
      `export const ValdiWebRenderer = webRendererModule.ValdiWebRenderer;`,
      ...runtimeExportNames.map((name) => `export const ${name} = designModule.${name};`),
    ].join("\n") + "\n",
  );

  const nodeModuleDirs = [
    path.join(bazelOutBin, "bzl/valdi/npm/node_modules"),
    path.join(bazelOutBin, "external/valdi/bzl/valdi/npm/node_modules"),
    path.join(bazelOutBin, "external/valdi+/bzl/valdi/npm/node_modules"),
  ].filter(existsSync);

  mkdirSync(path.dirname(outFile), { recursive: true });
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["safari16.6", "ios16.6", "chrome116", "firefox115"],
    minifySyntax: true,
    minifyWhitespace: false,
    legalComments: "inline",
    define: {
      __VALDI_API_VERSION__: JSON.stringify(valdiApiVersion),
    },
    alias: {
      opencraft_valdi_web_npm: webPkgDir,
      "path-browserify": pathShimFile,
    },
    nodePaths: nodeModuleDirs,
    loader: {
      ".bin": "binary",
      ".protodecl": "binary",
      ".png": "dataurl",
      ".jpg": "dataurl",
      ".jpeg": "dataurl",
      ".svg": "dataurl",
      ".webp": "dataurl",
    },
    banner: {
      js: "// Generated by packages/design-system-valdi/scripts/build-web.mjs (Snap Valdi MIT — see NOTICE)\n",
    },
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const bundleSource = readFileSync(outFile, "utf8");
const emittedExports = new Set();
for (const block of bundleSource.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
  for (const part of block[1].split(",")) {
    const tokens = part.trim().split(/\s+as\s+/);
    const exported = (tokens[1] ?? tokens[0]).trim();
    if (exported) emittedExports.add(exported);
  }
}

const dtsPath = outFile.replace(/\.mjs$/, ".d.mts");
if (existsSync(dtsPath)) {
  const dtsSource = readFileSync(dtsPath, "utf8");
  const missingExports = [];
  for (const m of dtsSource.matchAll(/^export\s+declare\s+(?:const|function|class)\s+([A-Za-z0-9_]+)/gm)) {
    const name = m[1];
    if (!emittedExports.has(name)) {
      missingExports.push(name);
    }
  }
  if (missingExports.length > 0) {
    throw new Error(
      `Valdi Web bundle missing runtime exports declared in ${path.basename(dtsPath)}: ${missingExports.join(", ")}`,
    );
  }
}

console.log(`Built & verified Valdi Web ESM bundle (${emittedExports.size} exports) -> ${outFile}`);
