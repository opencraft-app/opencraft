import { readFile, writeFile, mkdir, rename, stat, chmod, chown } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

// The shell entry holds the deployment-wide flock on inherited descriptor 9.
await stat("/proc/self/fd/9").catch(() => {
  throw Error("Use publish.sh to acquire the deployment lock");
});
const planPath = resolve(process.argv[2]);
const planBytes = await readFile(planPath);
const plan = JSON.parse(planBytes);
const requireValue = (valid, message) => {
  if (!valid) throw Error(message);
};
requireValue(plan.schemaVersion === 1 && /^[a-z0-9][a-z0-9-]{0,79}$/.test(plan.releaseId), "Invalid release identity");
for (const key of ["projectDirectory", "overrideFile", "candidateOverride", "stateDirectory", "sourceRepository"])
  requireValue(typeof plan[key] === "string" && isAbsolute(plan[key]), "Expected absolute " + key);
requireValue(
  Array.isArray(plan.composeFiles) &&
    plan.composeFiles.length > 0 &&
    plan.composeFiles.every(isAbsolute) &&
    plan.composeFiles.at(-1) === plan.overrideFile,
  "Override must be the final explicit Compose file",
);
requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(plan.service), "Invalid service");
requireValue(/^sha256:[a-f0-9]{64}$/.test(plan.candidateImageId), "Candidate must be an immutable image ID");
requireValue(/^[a-f0-9]{40,64}$/.test(plan.sourceRevision), "Expected a local source commit");
requireValue(
  Array.isArray(plan.verify) &&
    plan.verify.length > 0 &&
    plan.verify.every((v) => Array.isArray(v) && v.length && v.every((x) => typeof x === "string")),
  "Supply focused verification argv arrays",
);
requireValue(
  plan.rollback === undefined ||
    (plan.rollback &&
      Object.keys(plan.rollback).every((key) => ["override", "imageId"].includes(key)) &&
      typeof plan.rollback.override === "string" &&
      isAbsolute(plan.rollback.override) &&
      /^sha256:[a-f0-9]{64}$/.test(plan.rollback.imageId)),
  "Rollback requires a fixed compatible image and absolute override",
);
const argvList = (value) =>
  Array.isArray(value) &&
  value.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") && v[0].length > 0);
requireValue(
  plan.lifecycle === undefined ||
    (plan.lifecycle?.mode === "cold" &&
      argvList(plan.lifecycle.afterStop) &&
      plan.lifecycle.afterStop.length > 0 &&
      Object.keys(plan.lifecycle).every((key) => ["mode", "afterStop"].includes(key))),
  "Cold lifecycle requires afterStop ownership checks",
);
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: plan.projectDirectory,
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const error = Error("Command failed (status " + result.status + ", signal " + (result.signal ?? "none") + ")");
    error.output =
      String(result.stdout ?? "") +
      "\n[stderr]\n" +
      String(result.stderr ?? "") +
      (result.error ? "\n" + result.error.message : "");
    throw error;
  }
  return result.stdout;
};
run("git", ["-C", plan.sourceRepository, "cat-file", "-e", plan.sourceRevision + "^{commit}"]);
const state = resolve(plan.stateDirectory, plan.releaseId);
// All transitions use the same lifecycle contract, including recovery. The plan's
// checks own native quiescence; the publisher owns stop/check/replace/start ordering.
const composeArgs = [
  "compose",
  "--project-directory",
  plan.projectDirectory,
  ...plan.composeFiles.flatMap((file) => ["-f", file]),
];
const loggedRun = async (argv, name) => {
  const path = state + "/" + name + ".log";
  try {
    const output = run(argv[0], argv.slice(1));
    await writeFile(path, output.slice(-131072), { mode: 0o600 });
  } catch (error) {
    await writeFile(path, String(error.output ?? error.message).slice(-131072), { mode: 0o600 });
    throw Error(error.message + "; details: " + name + ".log");
  }
};
const transition = async (bytes, phase) => {
  if (plan.lifecycle?.mode === "cold") {
    await loggedRun(["docker", ...composeArgs, "stop", plan.service], phase + "-stop");
    for (let i = 0; i < plan.lifecycle.afterStop.length; i++)
      await loggedRun(plan.lifecycle.afterStop[i], phase + "-after-stop-" + i);
  }
  const metadata = await stat(plan.overrideFile),
    temp = plan.overrideFile + ".fast-release.tmp";
  await writeFile(temp, bytes, { mode: metadata.mode & 0o777 });
  await chmod(temp, metadata.mode & 0o777);
  await chown(temp, metadata.uid, metadata.gid);
  await rename(temp, plan.overrideFile);
  await loggedRun(
    ["docker", ...composeArgs, "up", "-d", "--no-deps", "--no-build", "--wait", "--wait-timeout", "180", plan.service],
    phase + "-up",
  );
};
if (process.argv[3] === "--rollback") {
  const old = JSON.parse(await readFile(state + "/receipt.json", "utf8"));
  requireValue(
    old.planSha256 === createHash("sha256").update(planBytes).digest("hex"),
    "Recovery plan differs from recorded plan",
  );
  requireValue(old.previousImageId && old.candidateImageId, "Release has no prepared rollback");
  const args = [
    "compose",
    "--project-directory",
    plan.projectDirectory,
    ...plan.composeFiles.flatMap((file) => ["-f", file]),
  ];
  const docker = (argv) => run("docker", argv);
  const live = JSON.parse(docker(["inspect", docker([...args, "ps", "--all", "--quiet", plan.service]).trim()]))[0];
  requireValue(
    [old.previousImageId, old.candidateImageId, old.rollbackImageId].includes(live.Image),
    "A later release owns the target; refusing rollback",
  );
  const previous = await readFile(state + "/previous-override.yaml"),
    next = await readFile(state + "/candidate-override.yaml");
  const recovery = old.rollbackImageId ? await readFile(state + "/rollback-override.yaml") : previous;
  const current = await readFile(plan.overrideFile);
  requireValue(
    current.equals(previous) || current.equals(next) || current.equals(recovery),
    "Configuration changed since release",
  );
  try {
    await transition(recovery, "recovery");
    const restored = JSON.parse(
      docker(["inspect", docker([...args, "ps", "--all", "--quiet", plan.service]).trim()]),
    )[0];
    requireValue(
      restored.Image === (old.rollbackImageId ?? old.previousImageId) &&
        restored.State.Running &&
        restored.State.Health?.Status === "healthy",
      "Recovery did not restore healthy previous image",
    );
    await writeFile(
      state + "/receipt.tmp",
      JSON.stringify({ ...old, phase: "rolled_back", updatedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    await rename(state + "/receipt.tmp", state + "/receipt.json");
  } catch (error) {
    await writeFile(
      state + "/receipt.tmp",
      JSON.stringify(
        { ...old, phase: "rollback_failed", rollbackError: error.message, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(state + "/receipt.tmp", state + "/receipt.json");
    throw error;
  }
  console.log("rolled_back");
  process.exit(0);
}
await mkdir(state, { mode: 0o700 }); // exclusive: a release ID is never reused
await chmod(state, 0o700);
const receipt = {
  schemaVersion: 1,
  releaseId: plan.releaseId,
  sourceRevision: plan.sourceRevision,
  planSha256: createHash("sha256").update(planBytes).digest("hex"),
  phase: "checking",
};
const record = async (phase) => {
  receipt.phase = phase;
  receipt.updatedAt = new Date().toISOString();
  await writeFile(state + "/receipt.tmp", JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await rename(state + "/receipt.tmp", state + "/receipt.json");
  console.log(phase);
};
await record("checking");
const docker = (args) => run("docker", args);
const inspect = (id) => JSON.parse(docker(["inspect", id]))[0];
const compose = (candidate = false) => [
  "compose",
  "--project-directory",
  plan.projectDirectory,
  ...plan.composeFiles.flatMap((file) => [
    "-f",
    candidate && file === plan.overrideFile ? plan.candidateOverride : file,
  ]),
];
try {
  const current = JSON.parse(docker([...compose(), "config", "--format", "json"]));
  const proposed = JSON.parse(docker([...compose(true), "config", "--format", "json"]));
  requireValue(current.services?.[plan.service] && proposed.services?.[plan.service], "Target service missing");
  const candidate = inspect(plan.candidateImageId);
  requireValue(candidate.Id === plan.candidateImageId, "Candidate image changed");
  requireValue(
    inspect(proposed.services[plan.service].image).Id === plan.candidateImageId,
    "Override does not select the candidate",
  );
  const stripImage = (value) => {
    const copy = structuredClone(value);
    delete copy.services[plan.service].image;
    return copy;
  };
  requireValue(
    isDeepStrictEqual(stripImage(current), stripImage(proposed)),
    "Fast release may only change the target service image",
  );
  let rollbackBytes, rollbackImageId;
  if (plan.rollback) {
    const args = [
      "compose",
      "--project-directory",
      plan.projectDirectory,
      ...plan.composeFiles.flatMap((file) => ["-f", file === plan.overrideFile ? plan.rollback.override : file]),
    ];
    const recovery = JSON.parse(docker([...args, "config", "--format", "json"]));
    requireValue(
      isDeepStrictEqual(stripImage(current), stripImage(recovery)),
      "Rollback may only change the target service image",
    );
    requireValue(
      inspect(plan.rollback.imageId).Id === plan.rollback.imageId &&
        inspect(recovery.services[plan.service].image).Id === plan.rollback.imageId,
      "Rollback override does not select the fixed image",
    );
    rollbackBytes = await readFile(plan.rollback.override);
    rollbackImageId = plan.rollback.imageId;
  }

  const ids = docker([...compose(), "ps", "--all", "--quiet"])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const before = new Map(
    ids.map((id) => {
      const value = inspect(id);
      return [value.Config.Labels["com.docker.compose.service"], value];
    }),
  );
  requireValue(before.size === Object.keys(plan.expectedImages ?? {}).length, "Expected image inventory is incomplete");
  for (const [service, value] of before) {
    requireValue(value.Image === plan.expectedImages[service], "Live baseline changed: " + service);
    requireValue(
      inspect(current.services[service].image).Id === value.Image,
      "Persistent config differs from live service: " + service,
    );
  }
  requireValue(before.has(plan.service), "Target container missing");
  const previous = await readFile(plan.overrideFile);
  const next = await readFile(plan.candidateOverride);
  await writeFile(state + "/plan.json", planBytes, { mode: 0o600 });
  await writeFile(state + "/previous-override.yaml", previous, { mode: 0o600 });
  await writeFile(state + "/candidate-override.yaml", next, { mode: 0o600 });
  if (rollbackBytes) await writeFile(state + "/rollback-override.yaml", rollbackBytes, { mode: 0o600 });
  if (rollbackImageId) receipt.rollbackImageId = rollbackImageId;
  receipt.previousImageId = before.get(plan.service).Image;
  receipt.candidateImageId = candidate.Id;
  const serviceContainer = () => inspect(docker([...compose(), "ps", "--all", "--quiet", plan.service]).trim());
  const unchanged = () => {
    for (const [service, value] of before)
      if (service !== plan.service) {
        const now = inspect(value.Id);
        requireValue(
          now.State.StartedAt === value.State.StartedAt && now.Image === value.Image && now.State.Running,
          "Unrelated service changed: " + service,
        );
      }
  };
  let mutated = false;
  try {
    await record("prepared");
    // Recheck after preparing the rollback receipt, immediately before mutation.
    for (const [service, value] of before)
      requireValue(
        inspect(value.Id).Image === plan.expectedImages[service] &&
          inspect(value.Id).State.StartedAt === value.State.StartedAt,
        "Baseline moved during preparation",
      );
    requireValue((await readFile(plan.overrideFile)).equals(previous), "Compose override changed during preparation");
    mutated = true;
    await record("applying");
    await transition(next, "apply");
    const live = serviceContainer();
    requireValue(
      live.Image === candidate.Id && live.State.Running && live.State.Health?.Status === "healthy",
      "Candidate is not healthy",
    );
    for (let index = 0; index < plan.verify.length; index++) {
      await loggedRun(plan.verify[index], "verify-" + index);
    }
    unchanged();
    await record("succeeded");
  } catch (error) {
    receipt.error = error.message;
    if (mutated) {
      try {
        await record("rolling_back");
        await transition(rollbackBytes ?? previous, "rollback");
        const live = serviceContainer();
        requireValue(
          live.Image === (receipt.rollbackImageId ?? receipt.previousImageId) &&
            live.State.Running &&
            live.State.Health?.Status === "healthy",
          "Rollback did not restore the previous healthy image",
        );
        unchanged();
        await record("rolled_back");
      } catch (rollbackError) {
        receipt.rollbackError = rollbackError.message;
        await record("rollback_failed");
      }
    } else await record("rejected");
    process.exitCode = 1;
  }
} catch (error) {
  receipt.error = error.message;
  await record("rejected");
  process.exitCode = 1;
}
