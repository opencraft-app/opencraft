import { execFileSync } from "node:child_process";

/** Browser tooling may live outside the checkout, but its native runtime must
 * work on this machine. Never auto-install packages or hide missing libraries. */
export function assertBrowserRuntimeDependencies(executable, {
  platform = process.platform,
  env = process.env,
  run = execFileSync,
} = {}) {
  if (platform !== "linux") return;
  if (typeof executable !== "string" || !executable) throw new Error("A confirmed Chromium executable is required");
  let output;
  try { output = run("ldd", [executable], { encoding: "utf8", env, timeout: 10_000 }); }
  catch (error) { throw new Error("Cannot inspect Chromium runtime dependencies; check the executable and ldd", { cause: error }); }
  const missing = String(output).split("\n").flatMap(line => {
    const match = /^\s*(\S+)\s+=>\s+not found\s*$/.exec(line);
    return match ? [match[1]] : [];
  });
  if (missing.length) throw new Error(`Chromium runtime libraries missing: ${missing.join(", ")}. See docs/build-matrix.md#linux-browser-smoke-prerequisites`);
}
