import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const valdiPackage = join(repoRoot, "packages/design-system-valdi");
const vendorDir = join(repoRoot, "apps/mobile-native/ios/Vendor");

const workspace = process.env.VALDI_WORKSPACE ? resolve(process.env.VALDI_WORKSPACE) : "";
const bazel =
  process.env.VALDI_BAZEL ||
  (existsSync("/private/tmp/valdi-toolchain/bin/bazel") ? "/private/tmp/valdi-toolchain/bin/bazel" : "bazel");

if (!workspace || !existsSync(join(workspace, "bzl/valdi/valdi_module.bzl"))) {
  console.error(
    "Set VALDI_WORKSPACE to a Snapchat/Valdi checkout (pinned commit bc20bfc0da56d89278516ca67a4a670bd8e6b5a8).",
  );
  process.exit(1);
}

const stageDir = join(workspace, "apps/opencraft_design_valdi");
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
for (const entry of ["BUILD.bazel", "tsconfig.json", "src"]) {
  cpSync(join(valdiPackage, entry), join(stageDir, entry), { recursive: true });
}

const extraFlags = process.argv.slice(2);
const args = [
  "build",
  "//apps/opencraft_design_valdi:OpenCraftValdi_ios",
  "--snap_flavor=platform_development",
  "--valdi_js_engine=jscore",
  "--jobs=6",
  ...extraFlags,
];

console.log(`Building OpenCraftValdi_ios in ${workspace}...`);
const buildResult = spawnSync(bazel, args, { cwd: workspace, stdio: "inherit" });
if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const archive = join(workspace, "bazel-bin/apps/opencraft_design_valdi/OpenCraftValdi_ios.xcframework.zip");
if (!existsSync(archive)) {
  console.error(`Expected xcframework zip at ${archive}`);
  process.exit(1);
}

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
const unpack = spawnSync("ditto", ["-x", "-k", archive, vendorDir], { stdio: "inherit" });
if (unpack.status !== 0) {
  process.exit(unpack.status ?? 1);
}

const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(join(vendorDir, "OpenCraftValdi.xcframework.sha256"), `${digest}  OpenCraftValdi_ios.xcframework.zip\n`);
console.log(`Unpacked OpenCraftValdi.xcframework into ${vendorDir} (sha256: ${digest})`);
