#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withArtifactWorkspace(action) {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-artifacts-"));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [separator, command, ...args] = process.argv.slice(2);
  if (separator !== "--" || !command) throw new Error("Usage: artifact-workspace.mjs -- command [args...]");
  process.exitCode = await withArtifactWorkspace(
    (directory) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          stdio: "inherit",
          env: { ...process.env, OPENCRAFT_ARTIFACT_WORKSPACE: directory },
        });
        const forward = (signal) => child.kill(signal);
        const interrupt = () => forward("SIGINT");
        const terminate = () => forward("SIGTERM");
        process.on("SIGINT", interrupt);
        process.on("SIGTERM", terminate);
        const detach = () => {
          process.off("SIGINT", interrupt);
          process.off("SIGTERM", terminate);
        };
        child.once("error", (error) => {
          detach();
          reject(error);
        });
        child.once("close", (code) => {
          detach();
          resolve(code ?? 1);
        });
      }),
  );
}
