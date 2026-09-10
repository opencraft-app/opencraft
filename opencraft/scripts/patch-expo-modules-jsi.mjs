import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "node_modules", "expo-modules-jsi");
const packageJsonPath = path.join(packageRoot, "package.json");
const headerPath = path.join(
  packageRoot,
  "apple",
  "Sources",
  "ExpoModulesJSI-Cxx",
  "include",
  "RuntimeScheduler.h",
);

const supportedVersion = "57.0.6";

if (!fs.existsSync(packageJsonPath) || !fs.existsSync(headerPath)) {
  throw new Error("expo-modules-jsi is missing; cannot apply the Xcode 26.2 compatibility patch.");
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== supportedVersion) {
  throw new Error(
    `Refusing to patch expo-modules-jsi ${packageJson.version}; expected ${supportedVersion}. Review the upstream package before updating.`,
  );
}

const replacements = [
  [
    "SWIFT_RETURNS_RETAINED RuntimeScheduler(void *scheduler, ScheduleFn fn) noexcept",
    "RuntimeScheduler(void *scheduler, ScheduleFn fn) noexcept",
  ],
  ["SWIFT_RETURNS_RETAINED RuntimeScheduler() {}", "RuntimeScheduler() {}"],
];

let source = fs.readFileSync(headerPath, "utf8");
let changed = false;

for (const [invalidDeclaration, validDeclaration] of replacements) {
  if (source.includes(invalidDeclaration)) {
    source = source.replace(invalidDeclaration, validDeclaration);
    changed = true;
    continue;
  }
  if (!source.includes(validDeclaration)) {
    throw new Error(`RuntimeScheduler.h no longer matches the reviewed declaration: ${validDeclaration}`);
  }
}

if (changed) {
  fs.writeFileSync(headerPath, source);
  console.log(`Patched expo-modules-jsi ${supportedVersion} for Xcode 26.2.`);
} else {
  console.log(`expo-modules-jsi ${supportedVersion} Xcode patch is already applied.`);
}
