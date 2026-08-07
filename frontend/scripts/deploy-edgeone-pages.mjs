import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultProjectName = "lightvela-preview";
const defaultEnvironment = "production";
const defaultArea = "global";
const defaultSmokeAttempts = 18;
const defaultSmokeRetryDelayMs = 5_000;
const smokeRequestTimeoutMs = 20_000;

export function resolveDeployDir(env = process.env) {
  const configured = env.EDGEONE_PAGES_DIR?.trim();
  if (configured) {
    const edgeOneOutput = join(configured, ".edgeone");
    return existsSync(edgeOneOutput) ? edgeOneOutput : configured;
  }
  if (existsSync(join("out", ".edgeone"))) return join("out", ".edgeone");
  if (existsSync("out")) return "out";
  throw new Error("No Next.js EdgeOne deploy output found. Run pnpm build:next first, or set EDGEONE_PAGES_DIR explicitly.");
}

function resolveToken(env = process.env) {
  const fromEnv = env.EDGEONE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const path = join(homedir(), ".tencentcloud", "edgeone_pages_token");
    const raw = readFileSync(path, "utf8").trim();
    if (raw) return raw;
  } catch {
    // Fall through to the EdgeOne CLI login session.
  }
  return null;
}

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function previewCookies(response) {
  const rawCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return rawCookies
    .flatMap((value) => value.split(/,(?=\s*[^;,]+=)/))
    .map((value) => value.trim().split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

async function openPreviewSession(deployUrl, fetchImpl) {
  const url = new URL(deployUrl);
  const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(smokeRequestTimeoutMs) });
  if (response.status >= 500) throw new Error(`Preview authentication returned HTTP ${response.status}`);
  const cookie = previewCookies(response);
  if (url.search && response.status >= 300 && response.status < 400 && !cookie) {
    throw new Error("Preview authentication did not return a cookie");
  }
  return { origin: url.origin, headers: cookie ? { cookie } : {} };
}

async function readResponse(session, pathname, fetchImpl) {
  const response = await fetchImpl(new URL(pathname, session.origin), {
    headers: session.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(smokeRequestTimeoutMs),
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { response, body };
}

function assertStatus(result, expectedStatus, label) {
  if (result.response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${result.response.status}, expected ${expectedStatus}`);
  }
}

function firstEntryScript(html) {
  const match = html.match(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/i);
  if (!match) throw new Error("Preview root HTML does not reference an entry JS asset");
  return match[1];
}

function firstFlightAsset(assetsRoot) {
  const file = walkFiles(assetsRoot).find((path) => path.endsWith(`${sep}index.txt`) && path !== join(assetsRoot, "index.txt"));
  if (!file) return null;
  const route = relative(assetsRoot, file).split(sep).join("/").replace(/\/index\.txt$/, ".txt");
  return { file, pathname: `/${route}` };
}

async function verifyEdgeOneDeploymentOnce({ deployUrl, deployDir, fetchImpl }) {
  const assetsRoot = join(deployDir, "assets");
  const localHtmlPath = join(assetsRoot, "index.html");
  if (!existsSync(localHtmlPath)) throw new Error(`EdgeOne smoke fixture is missing: ${localHtmlPath}`);

  const localHtml = readFileSync(localHtmlPath, "utf8");
  const entryScript = firstEntryScript(localHtml);
  const session = await openPreviewSession(deployUrl, fetchImpl);

  const root = await readResponse(session, "/", fetchImpl);
  assertStatus(root, 200, "Preview root HTML");
  if (!root.response.headers.get("content-type")?.includes("text/html") || !/<html[\s>]/i.test(root.body.toString("utf8"))) {
    throw new Error("Preview root did not return HTML");
  }

  const entry = await readResponse(session, entryScript, fetchImpl);
  assertStatus(entry, 200, "Preview entry JS");
  if (/^\s*</.test(entry.body.toString("utf8"))) {
    throw new Error("Preview entry JS returned HTML");
  }

  const flightAsset = firstFlightAsset(assetsRoot);
  if (flightAsset) {
    const flight = await readResponse(session, flightAsset.pathname, fetchImpl);
    assertStatus(flight, 200, "Preview Flight payload");
    if (!flight.body.equals(readFileSync(flightAsset.file))) {
      throw new Error(`Preview Flight payload differs from ${flightAsset.pathname}`);
    }
  }

  const searchPath = join(assetsRoot, "api", "search", "en-us");
  if (existsSync(searchPath)) {
    const search = await readResponse(session, "/api/search/en-us", fetchImpl);
    assertStatus(search, 200, "Preview search asset");
    if (!search.body.equals(readFileSync(searchPath))) {
      throw new Error("Preview search asset differs from /api/search/en-us");
    }
  }

  const missing = await readResponse(session, "/__edgeone-smoke__/missing-edgeone-smoke.js", fetchImpl);
  assertStatus(missing, 404, "Preview missing asset");
  if (/^\s*</.test(missing.body.toString("utf8"))) {
    throw new Error("Preview missing asset returned HTML");
  }
}

export async function verifyEdgeOneDeployment({
  deployUrl,
  deployDir,
  fetchImpl = fetch,
  attempts = defaultSmokeAttempts,
  retryDelayMs = defaultSmokeRetryDelayMs,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await verifyEdgeOneDeploymentOnce({ deployUrl, deployDir, fetchImpl });
      console.log(`[edgeone-smoke] passed on attempt ${attempt}/${attempts}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`[edgeone-smoke] attempt ${attempt}/${attempts} failed: ${error?.message ?? error}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
      }
    }
  }
  throw new Error(`EdgeOne Preview smoke failed after ${attempts} attempt(s): ${lastError?.message ?? "unknown error"}`);
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", rejectCommand);
    child.on("close", (status) => resolveCommand({ status, stdout, stderr }));
  });
}

export function parseEdgeOneDeploymentResult(output) {
  const line = output.trim().split(/\r?\n/).reverse().find((candidate) => candidate.startsWith("{") && candidate.includes('"deploymentId"'));
  if (line) return JSON.parse(line);

  const plainOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
  const url = plainOutput.match(/Deploy URL:\s*(https:\/\/\S+)/)?.[1];
  const deploymentId = plainOutput.match(/Deployment ID:\s*([^\s]+)/)?.[1];
  if (!url) throw new Error("EdgeOne CLI output did not include a deployment URL");
  return { deploymentId, url };
}

export async function main(env = process.env) {
  const projectName = env.EDGEONE_PAGES_PROJECT_NAME?.trim() || defaultProjectName;
  const environment = env.EDGEONE_PAGES_ENV?.trim() || defaultEnvironment;
  const area = env.EDGEONE_PAGES_AREA?.trim() || defaultArea;
  const deployDir = resolveDeployDir(env);
  const token = resolveToken(env);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "edgeone-pages-deploy-"));
  // The CLI selects Build Output behavior from the .edgeone basename and consumes parts of that directory.
  const temporaryDeployDir = join(temporaryRoot, ".edgeone");

  try {
    cpSync(deployDir, temporaryDeployDir, { recursive: true });
    const args = [
      "edgeone",
      "makers",
      "deploy",
      temporaryDeployDir,
      "--name",
      projectName,
      "--env",
      environment,
      "--area",
      area,
    ];
    // Keep the API token out of argv and process listings.
    const childEnv = token ? { ...env, EDGEONE_PAGES_API_TOKEN: token } : env;
    const result = await runCommand("npx", args, {
      stdio: ["inherit", "pipe", "pipe"],
      env: childEnv,
      shell: process.platform === "win32",
    });
    if ((result.status ?? 1) !== 0) {
      throw new Error(`EdgeOne deploy failed with exit code ${result.status ?? 1}`);
    }

    if (env.EDGEONE_PAGES_VERIFY_DEPLOYMENT === "1") {
      const deployment = parseEdgeOneDeploymentResult(result.stdout);
      await verifyEdgeOneDeployment({ deployUrl: deployment.url, deployDir });
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const currentModulePath = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
