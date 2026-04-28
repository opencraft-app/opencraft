import { spawnSync } from "node:child_process";

const projectName = process.env.CLOUDFLARE_PAGES_PROJECT_NAME?.trim() || "lightclaw";
const branch = process.env.CLOUDFLARE_PAGES_BRANCH?.trim() || "main";
const commitHash = process.env.CLOUDFLARE_PAGES_COMMIT_HASH?.trim();
const commitMessage = process.env.CLOUDFLARE_PAGES_COMMIT_MESSAGE?.trim();

const args = ["wrangler", "pages", "deploy", "dist", "--project-name", projectName];

if (branch) {
  args.push("--branch", branch);
}

if (commitHash) {
  args.push("--commit-hash", commitHash);
}

if (commitMessage) {
  args.push("--commit-message", commitMessage);
}

const result = spawnSync("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
