import { createHash } from "node:crypto";
import type { MakeDirectoryOptions, RmOptions } from "node:fs";
import {
  lstat,
  mkdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";

import type { DesktopProductIdentity } from "./product-identity.js";

export interface DesktopDirectoryPlan {
  readonly platform: NodeJS.Platform;
  readonly userDataDirectory: string;
  readonly legacyUserDataDirectory: string | null;
  readonly legacyDaemonName: string | null;
  readonly runtimeDirectory: string;
  readonly dshDataDirectory: string;
  readonly codexDataDirectory: string;
  readonly daemonEndpoint: string;
  readonly daemonTokenPath: string;
  readonly productHomeDirectory: string;
  readonly migrationAllowed: boolean;
}

export interface DesktopDirectoryFileSystem {
  lstat(path: string): ReturnType<typeof lstat>;
  mkdir(path: string, options: MakeDirectoryOptions & { recursive: true }): ReturnType<typeof mkdir>;
  rename(source: string, destination: string): ReturnType<typeof rename>;
  rm(path: string, options?: RmOptions): ReturnType<typeof rm>;
  symlink(target: string, path: string, type?: "dir" | "file" | "junction"): ReturnType<typeof symlink>;
}

export const nodeDesktopDirectoryFileSystem: DesktopDirectoryFileSystem = Object.freeze({
  lstat,
  mkdir,
  rename,
  rm,
  symlink,
});

export interface PreparedDesktopDirectories {
  readonly paths: DesktopDirectoryPlan;
  readonly status: "explicit" | "fresh" | "canonical-existing" | "migrated" | "legacy-active" | "legacy-fallback";
  readonly diagnostic?: string;
}

function endpointFor(userDataDirectory: string, platform: NodeJS.Platform, prefix = "opencraft-daemon"): string {
  return platform === "win32"
    ? `\\\\.\\pipe\\${prefix}-${createHash("sha256").update(userDataDirectory).digest("hex").slice(0, 24)}`
    : join(userDataDirectory, `${prefix}.sock`);
}

function withUserDataDirectory(plan: DesktopDirectoryPlan, userDataDirectory: string): DesktopDirectoryPlan {
  return Object.freeze({
    ...plan,
    userDataDirectory,
    runtimeDirectory: join(userDataDirectory, "runtime"),
    dshDataDirectory: join(userDataDirectory, "dsh"),
    codexDataDirectory: join(userDataDirectory, "codex"),
    daemonEndpoint: endpointFor(userDataDirectory, plan.platform),
    daemonTokenPath: join(userDataDirectory, "opencraft-daemon.token"),
    migrationAllowed: false,
  });
}

async function pathExists(fileSystem: DesktopDirectoryFileSystem, path: string): Promise<boolean> {
  try { await fileSystem.lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isDaemonEndpointActive(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolveActive) => {
    const socket = connect(endpoint);
    let settled = false;
    const done = (active: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolveActive(active);
    };
    const timeout = setTimeout(() => done(false), 250);
    timeout.unref();
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function ensureDirectoryRoots(fileSystem: DesktopDirectoryFileSystem, plan: DesktopDirectoryPlan): Promise<void> {
  await fileSystem.mkdir(plan.userDataDirectory, { recursive: true, mode: 0o700 });
  await fileSystem.mkdir(plan.runtimeDirectory, { recursive: true, mode: 0o700 });
  await fileSystem.mkdir(plan.productHomeDirectory, { recursive: true, mode: 0o700 });
}

export async function prepareDesktopDirectories(
  plan: DesktopDirectoryPlan,
  options: {
    readonly fileSystem?: DesktopDirectoryFileSystem;
    readonly legacyDaemonIsActive?: (endpoint: string) => Promise<boolean>;
  } = {},
): Promise<PreparedDesktopDirectories> {
  const fileSystem = options.fileSystem ?? nodeDesktopDirectoryFileSystem;
  const legacyDaemonIsActive = options.legacyDaemonIsActive ?? isDaemonEndpointActive;
  const legacy = plan.legacyUserDataDirectory;
  if (!plan.migrationAllowed || legacy === null) {
    await ensureDirectoryRoots(fileSystem, plan);
    return { paths: plan, status: "explicit" };
  }

  if (await pathExists(fileSystem, plan.userDataDirectory)) {
    await ensureDirectoryRoots(fileSystem, plan);
    return { paths: plan, status: "canonical-existing" };
  }
  if (!await pathExists(fileSystem, legacy)) {
    await ensureDirectoryRoots(fileSystem, plan);
    return { paths: plan, status: "fresh" };
  }

  const legacyDaemonName = plan.legacyDaemonName;
  if (legacyDaemonName === null) throw new Error("Legacy profile requires a daemon name");
  const legacyEndpoint = endpointFor(legacy, plan.platform, legacyDaemonName);
  if (await legacyDaemonIsActive(legacyEndpoint)) {
    const fallback = withUserDataDirectory(plan, legacy);
    await ensureDirectoryRoots(fileSystem, fallback);
    return {
      paths: fallback,
      status: "legacy-active",
      diagnostic: "The legacy OpenCraft profile is still owned by a running daemon; migration was deferred.",
    };
  }

  const legacyToken = join(plan.userDataDirectory, `${legacyDaemonName}.token`);
  const legacySocket = join(plan.userDataDirectory, `${legacyDaemonName}.sock`);
  let movedProfile = false;
  let movedToken = false;
  let compatibilityLink = false;
  try {
    await fileSystem.rename(legacy, plan.userDataDirectory);
    movedProfile = true;
    if (await pathExists(fileSystem, legacyToken) && !await pathExists(fileSystem, plan.daemonTokenPath)) {
      await fileSystem.rename(legacyToken, plan.daemonTokenPath);
      movedToken = true;
    }
    await fileSystem.rm(legacySocket, { force: true });
    await ensureDirectoryRoots(fileSystem, plan);
    await fileSystem.symlink(plan.userDataDirectory, legacy, plan.platform === "win32" ? "junction" : "dir");
    compatibilityLink = true;
    return { paths: plan, status: "migrated" };
  } catch (error) {
    try {
      if (compatibilityLink) await fileSystem.rm(legacy, { force: true });
      if (movedToken) await fileSystem.rename(plan.daemonTokenPath, legacyToken);
      if (movedProfile) await fileSystem.rename(plan.userDataDirectory, legacy);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "OpenCraft profile migration and rollback both failed");
    }
    const fallback = withUserDataDirectory(plan, legacy);
    await ensureDirectoryRoots(fileSystem, fallback);
    return {
      paths: fallback,
      status: "legacy-fallback",
      diagnostic: `OpenCraft profile migration was deferred: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function resolveDesktopDirectoryPlan(input: {
  readonly appDataDirectory: string;
  readonly homeDirectory: string;
  readonly product: DesktopProductIdentity;
  readonly requestedUserDataDirectory?: string | null;
  readonly requestedProductHomeDirectory?: string | null;
  readonly platform?: NodeJS.Platform;
}): DesktopDirectoryPlan {
  const requestedProfile = input.requestedUserDataDirectory?.trim() || null;
  const userDataDirectory = requestedProfile === null
    ? join(input.appDataDirectory, input.product.profileDirectoryName)
    : resolve(requestedProfile);
  const legacyName = input.product.legacyProfileDirectoryNames[0] ?? null;
  const legacyUserDataDirectory = requestedProfile === null && legacyName !== null
    ? join(input.appDataDirectory, legacyName)
    : null;
  const platform = input.platform ?? process.platform;
  const daemonEndpoint = endpointFor(userDataDirectory, platform);
  return Object.freeze({
    platform,
    userDataDirectory,
    legacyUserDataDirectory,
    legacyDaemonName: legacyUserDataDirectory === null ? null : input.product.legacyDaemonName ?? "opencraft-daemon",
    runtimeDirectory: join(userDataDirectory, "runtime"),
    dshDataDirectory: join(userDataDirectory, "dsh"),
    codexDataDirectory: join(userDataDirectory, "codex"),
    daemonEndpoint,
    daemonTokenPath: join(userDataDirectory, "opencraft-daemon.token"),
    productHomeDirectory: input.requestedProductHomeDirectory?.trim()
      ? resolve(input.requestedProductHomeDirectory.trim())
      : join(input.homeDirectory, ".opencraft"),
    migrationAllowed: requestedProfile === null,
  });
}
