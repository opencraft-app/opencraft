import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";

const repositoryRoot = resolve(__dirname, "../../../../..");
const releaseScript = resolve(repositoryRoot, "web/deploy/k3s/release.sh");
const runbookIndex = resolve(repositoryRoot, "docs/runbooks/k3s-release.md");
const webRunbook = resolve(repositoryRoot, "docs/runbooks/k3s-web-release.md");
const backendRunbook = resolve(
  repositoryRoot,
  "docs/runbooks/k3s-backend-release.md",
);

describe("independent k3s release contract", () => {
  it("provides one syntax-valid Web deploy entry", () => {
    expect(existsSync(releaseScript)).toBe(true);
    if (!existsSync(releaseScript)) return;

    execFileSync("/bin/sh", ["-n", releaseScript]);
    const help = execFileSync(releaseScript, ["--help"], {encoding: "utf8"});
    expect(help).toContain("deploy");
    expect(help).toContain("--builder-identity /absolute/private-key");
    expect(help).toContain("--target-identity /absolute/private-key");
    expect(help).toContain("--evidence /absolute/new-directory");
  });

  it("separates the builder and target trust boundaries", () => {
    const source = readFileSync(releaseScript, "utf8");
    for (const required of [
      "-o BatchMode=yes",
      "-o IdentitiesOnly=yes",
      "-i \"$builder_identity\"",
      "-i \"$target_identity\"",
      "docker version",
      "docker buildx inspect",
      "docker buildx imagetools inspect",
      "--platform linux/amd64",
      "k3s kubectl",
      "quote_remote_argument",
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toMatch(/PasswordAuthentication=yes/u);
    expect(source).not.toContain("kubectl config use-context");
    expect(source).not.toContain("--kubeconfig");
  });

  it("locks source, minimal context, immutable digest, rollback and evidence", () => {
    const source = readFileSync(releaseScript, "utf8");
    for (const required of [
      "git status --porcelain",
      "@{upstream}",
      "bun run --cwd web typecheck",
      "bun run --cwd web test",
      "bun run --cwd web security:scan",
      "bun run --cwd web/apps/client check:tui",
      "bun run --cwd web/apps/client test:tui",
      "bun run --cwd web/apps/client test:tui-build",
      "bun run --cwd web build:web",
      "bun run --cwd web/apps/client verify:web-fallback",
      "apps/client/dist",
      "deploy/devcloud/Dockerfile",
      "deploy/devcloud/nginx.conf",
      "@sha256:",
      "wait_for_rollout",
      "verify_target_pod",
      "imageID",
      "healthz-web",
      "/v1/me",
      "rollback_live_image",
      "trap cleanup",
      "release-evidence.json",
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toMatch(/(?:password|secret)[-_]?argument/iu);
  });

  it("treats an omitted unavailableReplicas field as zero", () => {
    const source = readFileSync(releaseScript, "utf8");
    const start = source.indexOf("deployment_is_ready() {");
    const end = source.indexOf("wait_for_rollout() {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const deploymentIsReady = source.slice(start, end);
    expect(() =>
      execFileSync(
        "/bin/sh",
        [
          "-c",
          `deployment_state() { printf '4 4 1 1 1 1 \\n'; }
target_kubectl() { printf '%s' 'registry.example/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
container=static
${deploymentIsReady}
deployment_is_ready raft-web-static 'registry.example/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`,
        ],
        {stdio: "pipe"},
      ),
    ).not.toThrow();
  });

  it("routes Web and Backend through separate runbooks", () => {
    for (const path of [runbookIndex, webRunbook, backendRunbook]) {
      expect(existsSync(path)).toBe(true);
    }
    if (![runbookIndex, webRunbook, backendRunbook].every(existsSync)) return;

    const index = readFileSync(runbookIndex, "utf8");
    const web = readFileSync(webRunbook, "utf8");
    const backend = readFileSync(backendRunbook, "utf8");
    expect(index).toContain("k3s-web-release.md");
    expect(index).toContain("k3s-backend-release.md");
    expect(web).toContain("web/deploy/k3s/release.sh deploy");
    expect(backend).toContain("migration Job");
    expect(backend).toContain("verify Job");
    expect(backend).toContain("向后兼容");
    expect(backend).toContain("非向后兼容");
    expect(backend).toContain("imageID");
  });
});
