import { createPrivateKey, sign } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const apple = "https://api.appstoreconnect.apple.com";
const bundleId = "app.opencraft";
const buildNumberPattern = /^[1-9][0-9]{0,3}$/u;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

function createReadClient(environment) {
  const { APP_STORE_APP_ID, ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_PRIVATE_KEY_BASE64 } = environment;
  if (!/^[0-9]+$/u.test(APP_STORE_APP_ID ?? "")) throw new Error("Missing or invalid App Store app ID");
  if (!/^[A-Z0-9]{10}$/u.test(ASC_API_KEY_ID ?? "") || !/^[a-fA-F0-9-]{36}$/u.test(ASC_API_ISSUER_ID ?? "")) {
    throw new Error("Missing or invalid App Store Connect API key identity");
  }
  const key = createPrivateKey(Buffer.from(ASC_API_PRIVATE_KEY_BASE64 ?? "", "base64"));
  const encode = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");
  const header = encode({ alg: "ES256", kid: ASC_API_KEY_ID, typ: "JWT" });
  function token() {
    const iat = Math.floor(Date.now() / 1000);
    const input = `${header}.${encode({ iss: ASC_API_ISSUER_ID, iat, exp: iat + 300, aud: "appstoreconnect-v1" })}`;
    const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
  }
  async function get(path, query = {}) {
    const url = new URL(path, apple);
    if (url.origin !== apple || !url.pathname.startsWith("/v1/")) throw new Error("Unexpected App Store Connect API URL");
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token()}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      }).catch(() => undefined);
      if (response?.ok) return response.json();
      const status = response?.status;
      if (attempt === 2 || (status && status !== 429 && status < 500)) {
        throw new Error(`App Store Connect GET ${url.pathname} failed (${status ?? "network error"})`);
      }
      await delay((attempt + 1) * 2_000);
    }
  }
  async function list(path, query = {}) {
    const records = [];
    const seen = new Set();
    let page = await get(path, { limit: 200, ...query });
    while (true) {
      if (!Array.isArray(page.data)) throw new Error("Invalid App Store Connect list response");
      records.push(...page.data);
      const next = page.links?.next;
      if (!next) return records;
      if (seen.has(next)) throw new Error("Invalid App Store Connect pagination");
      seen.add(next);
      page = await get(next);
    }
  }
  return { appId: APP_STORE_APP_ID, get, list };
}

export function nextBuildNumber(numbers) {
  let highest = 0;
  for (const number of numbers) {
    if (!buildNumberPattern.test(number ?? "")) throw new Error("An existing Apple build number is outside OpenCraft's 1–9999 format");
    highest = Math.max(highest, Number(number));
  }
  if (highest === 9999) throw new Error("Build numbers for this app version are exhausted");
  return String(highest + 1);
}

export function selectExternalGroup(groups, name) {
  const matching = groups.filter(group => group.attributes.isInternalGroup === false
    && (!name || group.attributes.name === name));
  return matching.length === 1 ? matching[0] : undefined;
}

export function testFlightStatus({ upload, build, externalState, group, listed }) {
  if ((!build && upload === "FAILED") || ["FAILED", "INVALID"].includes(build?.processingState)
    || externalState === "PROCESSING_EXCEPTION") return "processing_failed";
  if (build?.expired === true || externalState === "EXPIRED") return "expired";
  if (externalState === "MISSING_EXPORT_COMPLIANCE") return "export_compliance_required";
  if (externalState === "IN_EXPORT_COMPLIANCE_REVIEW") return "export_compliance_review";
  if (externalState === "BETA_REJECTED") return "beta_review_rejected";
  if (!build || build.processingState !== "VALID" || !externalState || externalState === "PROCESSING") return "processing";
  if (!group) return "external_group_selection_required";
  if (["WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW"].includes(externalState)) return "beta_review_pending";
  if (!listed) return "build_not_in_external_group";
  if (externalState === "IN_BETA_TESTING" && build.expired === false) return "installable";
  if (externalState === "READY_FOR_BETA_SUBMISSION") return "beta_review_submission_required";
  if (externalState === "READY_FOR_BETA_TESTING" || externalState === "BETA_APPROVED") return "testing_not_started";
  return "distribution_unavailable";
}

const uploadQuery = (version) => ({
  "filter[platform]": "IOS",
  "filter[cfBundleShortVersionString]": version,
  "fields[buildUploads]": "cfBundleVersion,createdDate,state",
});

function buildQuery(appId, version, number) {
  return {
    "filter[app]": appId,
    "filter[preReleaseVersion.version]": version,
    "filter[preReleaseVersion.platform]": "IOS",
    ...(number ? { "filter[version]": number } : {}),
    "fields[builds]": "version,processingState,expired",
  };
}

async function readStatus(client, version, number, group) {
  const [builds, uploads] = await Promise.all([
    client.list("/v1/builds", buildQuery(client.appId, version, number)),
    client.list(`/v1/apps/${client.appId}/buildUploads`, { ...uploadQuery(version), "filter[cfBundleVersion]": number }),
  ]);
  if (builds.length > 1) throw new Error("Apple returned multiple iOS builds for one version and build number");
  const build = builds[0];
  const latestUpload = uploads.reduce((latest, upload) =>
    !latest || upload.attributes.createdDate > latest.attributes.createdDate ? upload : latest, null);
  const state = latestUpload?.attributes.state;
  const upload = typeof state === "string" ? state : state?.state;
  const validBuild = build?.attributes.processingState === "VALID";
  const detail = validBuild && (await client.get(`/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`, {
    "fields[buildBetaDetails]": "externalBuildState",
  })).data;
  const externalState = detail?.attributes?.externalBuildState;
  const listed = Boolean(validBuild && group && (await client.list(`/v1/betaGroups/${encodeURIComponent(group.id)}/relationships/builds`))
    .some(candidate => candidate.id === build.id));
  return {
    version, number, buildId: build?.id ?? null, upload: upload ?? null,
    processing: build?.attributes.processingState ?? null, externalState: externalState ?? null,
    group: group?.attributes.name ?? null, listed,
    status: testFlightStatus({ upload, build: build?.attributes, externalState, group, listed }),
  };
}

async function main(mode, environment) {
  const client = createReadClient(environment);
  const app = (await client.get(`/v1/apps/${client.appId}`, { "fields[apps]": "bundleId" })).data;
  if (app?.attributes?.bundleId !== bundleId) throw new Error("App Store Connect app does not match app.opencraft");
  const appConfig = JSON.parse(await readFile("apps/mobile/app.json", "utf8"));
  const version = environment.IOS_VERSION || appConfig.expo.version;
  if (!versionPattern.test(version)) throw new Error("Invalid iOS marketing version");

  if (mode === "plan") {
    const [uploads, builds] = await Promise.all([
      client.list(`/v1/apps/${client.appId}/buildUploads`, uploadQuery(version)),
      client.list("/v1/builds", buildQuery(client.appId, version)),
    ]);
    const number = nextBuildNumber([
      ...uploads.map(record => record.attributes.cfBundleVersion),
      ...builds.map(record => record.attributes.version),
    ]);
    console.log(`Planned OpenCraft ${version} (${number})`);
    await appendFile(environment.GITHUB_OUTPUT, `version=${version}\nnumber=${number}\n`);
    return;
  }
  const number = environment.IOS_BUILD_NUMBER;
  if (mode !== "status" || !buildNumberPattern.test(number ?? "")) throw new Error("Expected status mode and an iOS build number");
  const groups = await client.list(`/v1/apps/${client.appId}/betaGroups`, {
    "fields[betaGroups]": "name,isInternalGroup",
  });
  const group = selectExternalGroup(groups, environment.OPENCRAFT_TESTFLIGHT_GROUP);
  const deadline = Date.now() + 12 * 60_000;
  let result;
  do {
    result = await readStatus(client, version, number, group);
    console.log(JSON.stringify(result));
    if (result.status !== "processing" || Date.now() >= deadline) break;
    await delay(20_000);
  } while (true);

  await writeFile(environment.TESTFLIGHT_STATUS_FILE, JSON.stringify(result, null, 2) + "\n");
  await appendFile(environment.GITHUB_STEP_SUMMARY,
    `## TestFlight ${version} (${number})\n\n`
    + `- Availability: \`${result.status}\`\n`
    + `- Apple upload: \`${result.upload ?? "not found"}\`\n`
    + `- Apple processing: \`${result.processing ?? "not found"}\`\n`
    + `- External test state: \`${result.externalState ?? "not available"}\`\n`
    + `- Assigned to the target group: ${result.listed ? "yes" : "no"}\n`);
  if (result.status !== "installable") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2], process.env);
}
