#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { notarize } from "@electron/notarize";
import { signAsync } from "@electron/osx-sign";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function signAndNotarizeMacos(appPath, environment = process.env) {
  const app = resolve(appPath);
  const entitlements = resolve(repositoryRoot, "apps/workbench-electron/native/entitlements.mac.plist");
  const identity = requiredEnvironment(environment, "CSC_NAME");
  const keychain = requiredEnvironment(environment, "CSC_KEYCHAIN");
  const appleId = requiredEnvironment(environment, "APPLE_ID");
  const appleIdPassword = requiredEnvironment(environment, "APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = requiredEnvironment(environment, "APPLE_TEAM_ID");
  await Promise.all([access(app), access(entitlements), access(keychain)]);

  await signAsync({
    app,
    identity,
    keychain,
    platform: "darwin",
    type: "distribution",
    identityValidation: true,
    strictVerify: true,
    optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
  });
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);

  await notarize({ appPath: app, appleId, appleIdPassword, teamId });
  await execFileAsync("xcrun", ["stapler", "staple", app]);
  await execFileAsync("xcrun", ["stapler", "validate", app]);
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2];
  if (!appPath) throw new Error("Usage: sign-notarize-macos <OpenCraft.app>");
  const app = await signAndNotarizeMacos(appPath);
  process.stdout.write(`[opencraft] signed and notarized ${app}\n`);
}
