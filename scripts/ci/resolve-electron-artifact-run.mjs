// Picks the Electron fork native artifacts run that CI should restore when no
// run is pinned with OPENCRAFT_ELECTRON_ARTIFACT_RUN_ID.
//
// A run qualifies when it succeeded in this repository, ran on the default
// branch or on the branch being built, still has the requested target's
// artifact, and was built from the same fork definition (fork.json) and build
// arguments (args.gn) as the checkout. The newest qualifying run wins. The
// restore step still verifies the downloaded runtime against fork.json.
//
//   node scripts/ci/resolve-electron-artifact-run.mjs <target>
//
// Reads GH_API_URL, GH_REPOSITORY, GH_TOKEN, DEFAULT_BRANCH and CURRENT_BRANCH
// from the environment and prints the run ID.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const WORKFLOW = "electron-native-artifacts.yml";
export const BUILD_INPUTS = ["vendor/electron/fork.json", "vendor/electron/args.gn"];
const PAGES = 3;

/** Blob IDs of the build inputs in the current checkout. */
export function localBuildInputs(cwd = process.cwd()) {
  return Object.fromEntries(
    BUILD_INPUTS.map((path) => [path, execFileSync("git", ["hash-object", path], { cwd, encoding: "utf8" }).trim()]),
  );
}

export async function resolveElectronArtifactRun({ target, repository, defaultBranch, currentBranch, local, api }) {
  if (!/^(linux-x64|windows-x64|macos-arm64|macos-x64)$/u.test(target))
    throw new Error("Unsupported native artifact target.");
  const branches = new Set([defaultBranch, currentBranch].filter(Boolean));
  const artifact = `opencraft-electron-${target}`;
  const rejected = [];
  for (let page = 1; page <= PAGES; page++) {
    const { workflow_runs: runs = [] } = await api(
      `/repos/${repository}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=50&page=${page}`,
    );
    for (const run of runs) {
      if (
        run.conclusion !== "success" ||
        run.head_repository?.full_name !== repository ||
        !branches.has(run.head_branch)
      )
        continue;
      const { artifacts = [] } = await api(
        `/repos/${repository}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(artifact)}`,
      );
      if (!artifacts.some((item) => item.name === artifact && !item.expired)) {
        rejected.push(`${run.id}: no ${artifact}`);
        continue;
      }
      let matches = true;
      for (const path of BUILD_INPUTS) {
        const content = await api(`/repos/${repository}/contents/${path}?ref=${run.head_sha}`, { optional: true });
        if (content?.sha !== local[path]) {
          matches = false;
          rejected.push(`${run.id}: different ${path}`);
          break;
        }
      }
      if (matches) return run.id;
    }
    if (runs.length < 50) break;
  }
  throw new Error(
    `No successful ${WORKFLOW} run on ${[...branches].join(" or ")} has an unexpired ${artifact} built from this ` +
      `fork.json and args.gn. Run "Electron fork native artifacts" (mode build, target ${target}) on this branch, ` +
      `or pin a run with OPENCRAFT_ELECTRON_ARTIFACT_RUN_ID.${rejected.length ? `\nChecked: ${rejected.slice(0, 10).join("; ")}` : ""}`,
  );
}

export function githubApi({ apiUrl, token }) {
  return async (path, { optional = false } = {}) => {
    const response = await fetch(apiUrl + path, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${path.split("?")[0]} failed (${response.status})`);
    return response.json();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GH_API_URL, GH_REPOSITORY, GH_TOKEN, DEFAULT_BRANCH, CURRENT_BRANCH } = process.env;
  const id = await resolveElectronArtifactRun({
    target: process.argv[2],
    repository: GH_REPOSITORY,
    defaultBranch: DEFAULT_BRANCH,
    currentBranch: CURRENT_BRANCH,
    local: localBuildInputs(),
    api: githubApi({ apiUrl: GH_API_URL, token: GH_TOKEN }),
  });
  process.stdout.write(`${id}\n`);
}
