#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { notarize } from "@electron/notarize";
import gracefulFs from "graceful-fs";
import { stapleAndValidateMacos } from "./staple-macos.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function loadMacosSigner() {
  // The signer walks tens of thousands of resources concurrently. Its binary
  // detector captures fs.open at import time, so install the EMFILE queue first.
  // This patch is confined to the standalone signing process.
  gracefulFs.gracefulify(fs);
  return import("@electron/osx-sign");
}

export async function signAndNotarizeMacos(appPath, environment = process.env, {
  sign,
  notarizeApp = notarize,
  execute = execFileAsync,
  staple = stapleAndValidateMacos,
} = {}) {
  const app = resolve(appPath);
  const entitlements = resolve(repositoryRoot, "apps/workbench-electron/native/entitlements.mac.plist");
  const identity = requiredEnvironment(environment, "CSC_NAME");
  const keychain = requiredEnvironment(environment, "CSC_KEYCHAIN");
  const appleId = requiredEnvironment(environment, "APPLE_ID");
  const appleIdPassword = requiredEnvironment(environment, "APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = requiredEnvironment(environment, "APPLE_TEAM_ID");
  await Promise.all([access(app), access(entitlements), access(keychain)]);

  const signApp = sign ?? (await loadMacosSigner()).signAsync;
  process.stdout.write("[opencraft] signing app and nested code\n");
  await signApp({
    app,
    identity,
    keychain,
    platform: "darwin",
    type: "distribution",
    identityValidation: true,
    strictVerify: true,
    optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
  });
  await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);

  process.stdout.write("[opencraft] signature verified; submitting app for notarization\n");
  try {
    await notarizeApp({ appPath: app, appleId, appleIdPassword, teamId });
  } catch (error) {
    // @electron/notarize 2.5.0 only reaches this error after Apple's Accepted
    // result. Retry ticket delivery without submitting the app again.
    if (!/^Failed to staple your application with code: (65|68)\b/u.test(String(error?.message))) throw error;
  }
  process.stdout.write("[opencraft] app accepted; attaching and validating its ticket\n");
  await staple(app);
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2];
  if (!appPath) throw new Error("Usage: sign-notarize-macos <OpenCraft.app>");
  const app = await signAndNotarizeMacos(appPath);
  process.stdout.write(`[opencraft] signed and notarized ${app}\n`);
}
