#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { stapleAndValidateMacos } from "./staple-macos.mjs";

const execFileAsync = promisify(execFile);

export async function runXcrun(args, execute = execFileAsync) {
  try {
    return await execute("xcrun", args, { timeout: 45 * 60 * 1000 });
  } catch (error) {
    // execFile's error includes argv, which can contain the Apple password.
    // Preserve only the exit code so stapling can retry without exposing argv.
    throw Object.assign(new Error(`xcrun ${args[0]} ${args[1]} failed`), { code: error.code });
  }
}

export async function notarizeMacosDmg(dmgPath, environment = process.env, run = runXcrun) {
  const credentials = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"].map(name => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  });
  const dmg = resolve(dmgPath);
  if (!dmg.endsWith(".dmg")) throw new Error("Expected a final .dmg artifact");
  await access(dmg);
  const { stdout } = await run([
    "notarytool", "submit", dmg,
    "--apple-id", credentials[0], "--password", credentials[1], "--team-id", credentials[2],
    "--wait", "--timeout", "40m", "--output-format", "json",
  ]);
  const result = JSON.parse(stdout);
  if (result.status !== "Accepted") {
    throw new Error(`DMG notarization was not accepted (status: ${result.status}, request: ${result.id})`);
  }
  await stapleAndValidateMacos(dmg, { run });
  return dmg;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: notarize-macos-dmg <OpenCraft.dmg>");
  const dmg = await notarizeMacosDmg(process.argv[2]);
  process.stdout.write(`[opencraft] notarized and stapled ${dmg}\n`);
}
