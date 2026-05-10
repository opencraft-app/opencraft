import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ARTIFACT_MODE_REQUIRED = "required";
export const ARTIFACT_TYPE = "application/vnd.lightvela.frontend.pages.v1";
export const DIST_MEDIA_TYPE = "application/vnd.lightvela.frontend.dist.v1.tar+gzip";
export const MANIFEST_MEDIA_TYPE = "application/vnd.lightvela.frontend.manifest.v1+json";
export const MANIFEST_FILE = "manifest.json";
export const ARCHIVE_FILE = "dist.tar.gz";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);
const SECRET_KEY_RE = /(TOKEN|PASSWORD|SECRET|PRIVATE|CREDENTIAL)/i;
const PLACEHOLDER_RE = /^\$\{\{.*\}\}$|^(changeme|change_me|placeholder|replace_me|todo|test|dummy)$/i;
const ARTIFACT_NOT_FOUND_RE = /(not\s+found|404|manifest\s+unknown|name\s+unknown|repository\s+unknown|not\s+exist|does\s+not\s+exist|failed\s+to\s+resolve.*not\s+found)/i;

export function resolveArtifactMode(env = process.env) {
  const rawMode = env.FRONTEND_ARTIFACT_MODE?.trim() ?? "";
  if (!rawMode) return "";
  if (rawMode !== ARTIFACT_MODE_REQUIRED) {
    throw new Error(`unsupported FRONTEND_ARTIFACT_MODE ${rawMode}`);
  }
  return rawMode;
}

export function normalizeComboIdForTag(comboId) {
  const tagPart = String(comboId)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!tagPart) {
    throw new Error(`frontend artifact combo id ${comboId} does not produce a valid tag segment`);
  }
  if (tagPart.length > 128) {
    throw new Error(`frontend artifact combo tag segment is too long: ${tagPart.length}`);
  }
  return tagPart;
}

export function resolveShortSha(sourceSha) {
  const trimmed = String(sourceSha ?? "").trim();
  if (!FULL_SHA_RE.test(trimmed)) {
    throw new Error("FRONTEND_ARTIFACT_SOURCE_SHA must be a full 40-character git SHA");
  }
  return trimmed.slice(0, 12).toLowerCase();
}

export function resolveArtifactTag(sourceSha, comboId) {
  return `${resolveShortSha(sourceSha)}-${normalizeComboIdForTag(comboId)}`;
}

export function validateArtifactPrerequisites(env = process.env) {
  const mode = resolveArtifactMode(env);
  if (!mode) return;
  const missing = [];
  const orasPath = env.ORAS_BIN?.trim();
  if (orasPath ? !isExecutable(orasPath) : !commandExists("oras")) missing.push("oras");
  if (!env.FRONTEND_ARTIFACT_REPOSITORY?.trim()) missing.push("FRONTEND_ARTIFACT_REPOSITORY");
  if (!env.FRONTEND_ARTIFACT_SOURCE_SHA?.trim()) missing.push("FRONTEND_ARTIFACT_SOURCE_SHA");
  if (!env.REGISTRY_USERNAME?.trim()) missing.push("REGISTRY_USERNAME");
  if (!env.REGISTRY_PASSWORD?.trim()) missing.push("REGISTRY_PASSWORD");
  if (missing.length > 0) {
    throw new Error(`frontend artifact required mode is missing prerequisite(s): ${missing.join(", ")}`);
  }
  resolveShortSha(env.FRONTEND_ARTIFACT_SOURCE_SHA);
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(commandName) {
  const result = spawnSync("sh", ["-c", `command -v ${commandName} >/dev/null 2>&1`], { stdio: "ignore" });
  return result.status === 0;
}

export function collectFiles(rootDir) {
  const root = resolve(rootDir);
  const files = [];
  function visit(dir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  visit(root);
  return files;
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

export function computeContentIdentity(outputDir) {
  const root = resolve(outputDir);
  const hash = createHash("sha256");
  for (const filePath of collectFiles(root)) {
    const stat = statSync(filePath);
    const rel = relative(root, filePath).split(sep).join("/");
    const fileHash = sha256File(filePath);
    hash.update(`${rel}\0${stat.mode & 0o777}\0${fileHash}\n`);
  }
  return hash.digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function readIndexEntry(outputDir) {
  const indexPath = join(outputDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`frontend artifact output is missing index.html: ${outputDir}`);
  }
  const html = readFileSync(indexPath, "utf8");
  const match = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/);
  if (!match) {
    throw new Error("frontend artifact index.html does not reference an entry /assets/index-*.js file");
  }
  const entryJs = match[1];
  const entryPath = join(outputDir, entryJs.replace(/^\//, ""));
  if (!existsSync(entryPath)) {
    throw new Error(`frontend artifact entry JS is missing: ${entryJs}`);
  }
  return {
    indexPath,
    entryJs,
    entryPath,
  };
}

function resolveBakedEnv(comboEnv) {
  const bakedEnv = {
    VITE_REGION: comboEnv.VITE_REGION,
    VITE_AUTH_API_BASE_URL: comboEnv.VITE_AUTH_API_BASE_URL,
    VITE_AEGIS_ENABLED: comboEnv.VITE_AEGIS_ENABLED,
  };
  if (comboEnv.VITE_AEGIS_ID) bakedEnv.VITE_AEGIS_ID = comboEnv.VITE_AEGIS_ID;
  if (comboEnv.VITE_AEGIS_HOST_URL) bakedEnv.VITE_AEGIS_HOST_URL = comboEnv.VITE_AEGIS_HOST_URL;
  return Object.fromEntries(Object.entries(bakedEnv).filter(([, value]) => value !== undefined));
}

function toolchain(env) {
  return {
    node: env.NODE_VERSION ?? process.version,
    pnpm: env.PNPM_VERSION ?? env.npm_config_user_agent?.match(/pnpm\/([^\s]+)/)?.[1] ?? "unknown",
  };
}

function ensureNoSecretLeaks(outputDir, manifest, env) {
  const candidates = Object.entries(env)
    .filter(([key, value]) => SECRET_KEY_RE.test(key) && !key.startsWith("VITE_") && typeof value === "string")
    .map(([key, value]) => [key, value.trim()])
    .filter(([, value]) => value.length >= 12 && !PLACEHOLDER_RE.test(value));
  if (candidates.length === 0) return;

  const manifestText = JSON.stringify(manifest);
  for (const [key, value] of candidates) {
    if (manifestText.includes(value)) {
      throw new Error(`frontend artifact manifest contains secret-like env value from ${key}`);
    }
  }

  const root = resolve(outputDir);
  for (const filePath of collectFiles(root)) {
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const text = readFileSync(filePath, "utf8");
    for (const [key, value] of candidates) {
      if (text.includes(value)) {
        const rel = relative(root, filePath).split(sep).join("/");
        throw new Error(`frontend artifact text asset ${rel} contains secret-like env value from ${key}`);
      }
    }
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: options.encoding,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
  return result;
}

function getRegistryHost(repository) {
  return repository.split("/", 1)[0];
}

function repositoryFromRef(ref) {
  const lastSlash = ref.lastIndexOf("/");
  const tagSeparator = ref.lastIndexOf(":");
  if (tagSeparator <= lastSlash) {
    throw new Error(`frontend artifact ref must include a tag: ${ref}`);
  }
  return ref.slice(0, tagSeparator);
}

function orasBin(env) {
  return env.ORAS_BIN?.trim() || "oras";
}

function orasLogin(repository, env, options = {}) {
  if (options.dryRun) return;
  const username = env.REGISTRY_USERNAME?.trim();
  const password = env.REGISTRY_PASSWORD?.trim();
  if (!username || !password) {
    throw new Error("REGISTRY_USERNAME and REGISTRY_PASSWORD are required for ORAS login");
  }
  runCommand(orasBin(env), ["login", getRegistryHost(repository), "-u", username, "--password-stdin"], {
    input: password,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    env,
  });
}

function tryPullArtifact(ref, outputDir, env, options = {}) {
  if (options.dryRun) return false;
  const result = spawnSync(orasBin(env), ["pull", ref, "-o", outputDir], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (ARTIFACT_NOT_FOUND_RE.test(output)) return false;
  const reason = output ? `: ${output}` : "";
  throw new Error(`failed to inspect existing frontend artifact ${ref}${reason}`);
}

function orasPush(ref, manifestPath, archivePath, env, options = {}) {
  const args = [
    "push",
    "--artifact-type",
    ARTIFACT_TYPE,
    ref,
    `${MANIFEST_FILE}:${MANIFEST_MEDIA_TYPE}`,
    `${ARCHIVE_FILE}:${DIST_MEDIA_TYPE}`,
  ];
  if (options.dryRun) return { command: orasBin(env), args };
  if (dirname(manifestPath) !== dirname(archivePath)) {
    throw new Error("frontend artifact manifest and archive must be in the same directory for ORAS push");
  }
  runCommand(orasBin(env), args, { env, cwd: dirname(manifestPath) });
  return { command: orasBin(env), args };
}

function createArchive(outputDir, archivePath) {
  runCommand("tar", ["-czf", archivePath, "-C", outputDir, "."]);
}

export function buildArtifactManifest({ combo, projectName, comboEnv, outputDir, repository, sourceSha, createdAt = new Date().toISOString(), env = process.env }) {
  const shortSha = resolveShortSha(sourceSha);
  const fullSha = String(sourceSha).trim().toLowerCase();
  const tag = `${shortSha}-${normalizeComboIdForTag(combo.id)}`;
  const { indexPath, entryJs, entryPath } = readIndexEntry(outputDir);
  const contentIdentitySha256 = computeContentIdentity(outputDir);
  const bakedEnv = resolveBakedEnv(comboEnv);
  const stableProvenance = {
    schemaVersion: 1,
    sourceSha: fullSha,
    shortSha,
    comboId: combo.id,
    region: combo.region,
    channel: combo.channel,
    projectName,
    outputDir: combo.outputDir,
    buildCommand: combo.buildCommand,
    deployCommand: combo.deployCommand,
    artifact: {
      repository,
      tag,
    },
    bakedEnv,
    assets: {
      entryJs,
      entryJsSha256: sha256File(entryPath),
    },
    identity: {
      contentIdentitySha256,
    },
  };
  const provenanceIdentitySha256 = sha256Json(stableProvenance);
  return {
    schemaVersion: 1,
    sourceSha: fullSha,
    shortSha,
    comboId: combo.id,
    region: combo.region,
    channel: combo.channel,
    projectName,
    outputDir: combo.outputDir,
    buildCommand: combo.buildCommand,
    deployCommand: combo.deployCommand,
    artifact: {
      repository,
      tag,
      ref: `${repository}:${tag}`,
    },
    identity: {
      contentIdentitySha256,
      provenanceIdentitySha256,
    },
    bakedEnv,
    assets: {
      indexHtmlSha256: sha256File(indexPath),
      entryJs,
      entryJsSha256: sha256File(entryPath),
    },
    archive: {
      file: ARCHIVE_FILE,
      sha256: "",
      bytes: 0,
    },
    toolchain: toolchain(env),
    createdAt,
  };
}

function writeManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function artifactIdentitiesMatch(a, b) {
  return a?.sourceSha === b?.sourceSha
    && a?.comboId === b?.comboId
    && a?.identity?.contentIdentitySha256 === b?.identity?.contentIdentitySha256
    && a?.identity?.provenanceIdentitySha256 === b?.identity?.provenanceIdentitySha256;
}

export function archiveFrontendArtifact({ combo, projectName, comboEnv, env = process.env, log = console.log, dryRun = false, workDir } = {}) {
  const repository = env.FRONTEND_ARTIFACT_REPOSITORY?.trim();
  const sourceSha = env.FRONTEND_ARTIFACT_SOURCE_SHA?.trim();
  if (!repository) throw new Error("FRONTEND_ARTIFACT_REPOSITORY is required");
  if (!sourceSha) throw new Error("FRONTEND_ARTIFACT_SOURCE_SHA is required");
  const outputDir = resolve(comboEnv.EDGEONE_PAGES_DIR || comboEnv.CLOUDFLARE_PAGES_DIR || combo.outputDir);
  if (!existsSync(outputDir)) throw new Error(`frontend artifact output dir is missing: ${outputDir}`);

  const tempDir = workDir || mkdtempSync(join(tmpdir(), "frontend-artifact-"));
  mkdirSync(tempDir, { recursive: true });
  const manifestPath = join(tempDir, MANIFEST_FILE);
  const archivePath = join(tempDir, ARCHIVE_FILE);
  const manifest = buildArtifactManifest({ combo, projectName, comboEnv, outputDir, repository, sourceSha, env });
  ensureNoSecretLeaks(outputDir, manifest, env);

  createArchive(outputDir, archivePath);
  manifest.archive.sha256 = sha256File(archivePath);
  manifest.archive.bytes = statSync(archivePath).size;
  writeManifest(manifestPath, manifest);

  const ref = manifest.artifact.ref;
  if (!dryRun) {
    orasLogin(repository, env);
    const existingDir = mkdtempSync(join(tmpdir(), "frontend-artifact-existing-"));
    try {
      if (tryPullArtifact(ref, existingDir, env)) {
        const existingManifestPath = join(existingDir, MANIFEST_FILE);
        if (!existsSync(existingManifestPath)) {
          throw new Error(`existing frontend artifact ${ref} does not contain ${MANIFEST_FILE}`);
        }
        const existing = readManifest(existingManifestPath);
        if (!artifactIdentitiesMatch(existing, manifest)) {
          throw new Error(`frontend artifact ${ref} already exists with different identity`);
        }
        log(`frontend artifact exists with matching identity; skip push: ${ref}`);
        return { manifest, manifestPath, archivePath, ref, skippedPush: true };
      }
    } finally {
      rmSync(existingDir, { recursive: true, force: true });
    }
  }

  const push = orasPush(ref, manifestPath, archivePath, env, { dryRun });
  log(`frontend artifact archived: ${ref}`);
  return { manifest, manifestPath, archivePath, ref, skippedPush: false, push };
}

export function verifyFrontendArtifact({ ref, expectedManifest, env = process.env, log = console.log, dryRun = false, workDir } = {}) {
  if (!ref) throw new Error("frontend artifact ref is required");
  const tempDir = workDir || mkdtempSync(join(tmpdir(), "frontend-artifact-verify-"));
  mkdirSync(tempDir, { recursive: true });
  if (!dryRun) {
    const repository = repositoryFromRef(ref);
    orasLogin(repository, env);
    const pulled = tryPullArtifact(ref, tempDir, env);
    if (!pulled) throw new Error(`failed to pull frontend artifact ${ref}`);
  }
  const manifestPath = join(tempDir, MANIFEST_FILE);
  const archivePath = join(tempDir, ARCHIVE_FILE);
  if (!existsSync(manifestPath)) throw new Error(`frontend artifact ${ref} is missing ${MANIFEST_FILE}`);
  if (!existsSync(archivePath)) throw new Error(`frontend artifact ${ref} is missing ${ARCHIVE_FILE}`);
  const manifest = readManifest(manifestPath);
  if (expectedManifest && !artifactIdentitiesMatch(manifest, expectedManifest)) {
    throw new Error(`frontend artifact ${ref} pulled manifest identity does not match expected build`);
  }
  if (sha256File(archivePath) !== manifest.archive?.sha256) {
    throw new Error(`frontend artifact ${ref} archive sha256 mismatch`);
  }
  if (statSync(archivePath).size !== manifest.archive?.bytes) {
    throw new Error(`frontend artifact ${ref} archive size mismatch`);
  }
  const extractDir = join(tempDir, "dist");
  mkdirSync(extractDir, { recursive: true });
  runCommand("tar", ["-xzf", archivePath, "-C", extractDir]);
  const rebuilt = buildArtifactManifest({
    combo: {
      id: manifest.comboId,
      region: manifest.region,
      channel: manifest.channel,
      outputDir: manifest.outputDir,
      buildCommand: manifest.buildCommand,
      deployCommand: manifest.deployCommand,
    },
    projectName: manifest.projectName,
    comboEnv: {
      ...manifest.bakedEnv,
      CLOUDFLARE_PAGES_DIR: manifest.outputDir,
    },
    outputDir: extractDir,
    repository: manifest.artifact.repository,
    sourceSha: manifest.sourceSha,
    createdAt: manifest.createdAt,
    env,
  });
  if (rebuilt.identity.contentIdentitySha256 !== manifest.identity.contentIdentitySha256) {
    throw new Error(`frontend artifact ${ref} extracted content identity mismatch`);
  }
  if (rebuilt.assets.entryJsSha256 !== manifest.assets.entryJsSha256) {
    throw new Error(`frontend artifact ${ref} extracted entry JS hash mismatch`);
  }
  log(`frontend artifact verified: ${ref}`);
  return { manifest, ref };
}

export function archiveAndVerifyFrontendArtifact(options) {
  const archived = archiveFrontendArtifact(options);
  if (!options?.dryRun) {
    verifyFrontendArtifact({
      ref: archived.ref,
      expectedManifest: archived.manifest,
      env: options.env,
      log: options.log,
    });
  }
  return archived;
}

function parseCliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--") {
      continue;
    }
    if (item === "--dry-run") {
      args.dryRun = true;
    } else if (item.startsWith("--")) {
      args[item.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

export function runArchiveCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv);
  const combo = JSON.parse(readFileSync(args.combo, "utf8"));
  const comboEnv = JSON.parse(readFileSync(args["combo-env"], "utf8"));
  archiveAndVerifyFrontendArtifact({
    combo,
    projectName: args["project-name"] || combo.projectName,
    comboEnv,
    env,
    dryRun: Boolean(args.dryRun),
  });
}

export function runVerifyCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv);
  verifyFrontendArtifact({
    ref: args.ref,
    env,
    dryRun: Boolean(args.dryRun),
    workDir: args.dir,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runArchiveCli();
}
