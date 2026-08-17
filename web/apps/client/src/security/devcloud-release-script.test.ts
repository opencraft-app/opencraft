import {execFileSync, spawn} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {createServer} from "node:net";
import {get} from "node:http";
import {tmpdir} from "node:os";
import {resolve} from "node:path";

const repositoryRoot = resolve(__dirname, "../../../../..");
const releaseScript = resolve(
  repositoryRoot,
  "web/deploy/devcloud/release.sh",
);
const previewServer = resolve(
  repositoryRoot,
  "web/deploy/devcloud/preview-server.ts",
);
const rootAgents = resolve(repositoryRoot, "AGENTS.md");
const k3sRunbook = resolve(repositoryRoot, "docs/runbooks/k3s-release.md");
const k3sWebRunbook = resolve(
  repositoryRoot,
  "docs/runbooks/k3s-web-release.md",
);
const devcloudManifest = resolve(
  repositoryRoot,
  "web/deploy/devcloud/static.yaml",
);
const devcloudDockerfile = resolve(
  repositoryRoot,
  "web/deploy/devcloud/Dockerfile",
);

describe("DevCloud Web release contract", () => {
  it("provides one shell entry for preview and immutable deployment", () => {
    expect(existsSync(releaseScript)).toBe(true);
    if (!existsSync(releaseScript)) return;

    execFileSync("/bin/sh", ["-n", releaseScript]);
    const help = execFileSync(releaseScript, ["--help"], {
      encoding: "utf8",
    });
    expect(help).toContain("preview");
    expect(help).toContain("preview-stop");
    expect(help).toContain("deploy --kubeconfig");
    expect(help).toContain("--builder root@9.134.208.109");
  });

  it("locks clean Git, exact Web gates, digest rollout, verification and rollback", () => {
    expect(existsSync(releaseScript)).toBe(true);
    if (!existsSync(releaseScript)) return;
    const source = readFileSync(releaseScript, "utf8");

    for (const required of [
      "git status --porcelain",
      "@{upstream}",
      "bun run --cwd web typecheck",
      "bun run --cwd web test",
      "bun run --cwd web security:scan",
      "bun run --cwd web build:web",
      "bun run --cwd web/apps/client verify:web-fallback",
      "umask 022",
      "bun web/deploy/devcloud/preview-server.ts",
      "ssh",
      "scp",
      "docker buildx imagetools inspect",
      "--platform linux/amd64",
      "deploy/devcloud/Dockerfile",
      "wait_for_rollout",
      "imageID",
      "select(.name == $container)",
      "healthz-web",
      "wget -qO- http://127.0.0.1:8080/join",
      "trap cleanup",
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain("kubectl config use-context");
    expect(source).not.toMatch(/kubectl[\s\S]{0,180}?rollout status/u);
    expect(source).not.toContain("require_docker");
    expect(source).not.toContain("Docker daemon 未运行");
    expect(source).not.toContain("docker run");
    expect(source).not.toMatch(/curl[\s\S]{0,120}?\$service_ip\/join/u);
    expect(source).not.toMatch(/(?:password|secret)[-_]?argument/iu);
  });

  it("pins the Web runtime base to the Tencent mirror", () => {
    const source = readFileSync(devcloudDockerfile, "utf8");
    expect(source).toMatch(
      /^FROM mirror\.ccs\.tencentyun\.com\/nginxinc\/nginx-unprivileged:1\.29-alpine@sha256:[0-9a-f]{64}$/mu,
    );
    expect(source).not.toContain("FROM nginxinc/nginx-unprivileged");
  });

  it("serves the native Mac build without a local container runtime", () => {
    expect(existsSync(previewServer)).toBe(true);
    if (!existsSync(previewServer)) return;
    const source = readFileSync(previewServer, "utf8");
    expect(source).toContain("healthz-web");
    expect(source).toContain("index.html");
    expect(source).toContain("Cache-Control");
    expect(source).not.toContain("docker");
  });

  it("matches Nginx asset 404 and SPA fallback behavior", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "vela-preview-test-"));
    mkdirSync(resolve(root, "assets"));
    mkdirSync(resolve(root, "_expo/static"), {recursive: true});
    writeFileSync(resolve(root, "index.html"), "<!doctype html><html>vela</html>");
    const port = await availablePort();
    const child = spawn(
      "bun",
      [previewServer, "--root", root, "--port", String(port)],
      {stdio: "ignore"},
    );
    try {
      await waitForHTTP(`http://127.0.0.1:${port}/healthz-web`);
      expect((await httpGet(`http://127.0.0.1:${port}/assets/missing.js`)).status)
        .toBe(404);
      expect((await httpGet(
        `http://127.0.0.1:${port}/_expo/static/missing.js`,
      )).status).toBe(404);
      const join = await httpGet(`http://127.0.0.1:${port}/join`);
      expect(join.status).toBe(200);
      expect(join.body).toContain("<html>");
    } finally {
      child.kill("SIGTERM");
      rmSync(root, {force: true, recursive: true});
    }
  });

  it("routes live publishing to the independent k3s runbook", () => {
    expect(existsSync(rootAgents)).toBe(true);
    expect(existsSync(k3sRunbook)).toBe(true);
    if (!existsSync(rootAgents) || !existsSync(k3sRunbook)) return;
    const source = readFileSync(rootAgents, "utf8");
    const runbook = readFileSync(k3sRunbook, "utf8");
    const webRunbook = readFileSync(k3sWebRunbook, "utf8");

    expect(source).toContain("docs/runbooks/k3s-release.md");
    expect(source).toContain("旧共享前端环境已退役");
    expect(runbook).toContain("raft-web-static");
    expect(source).toContain("不使用默认 kube context");
    expect(source).toContain("Mac 不依赖 Docker daemon");
    expect(runbook).toContain("root@21.91.75.85:36000");
    expect(webRunbook).toContain("immutable registry digest");
  });

  it("keeps the checked-in DevCloud manifest aligned with the live workload", () => {
    const source = readFileSync(devcloudManifest, "utf8");
    expect(source).not.toContain("vela-web-static");
    expect(source).toContain("name: raft-web-static");
    expect(source).toContain("app.kubernetes.io/name: raft-web-static");
  });
});

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配预览测试端口"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHTTP(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await httpGet(url);
      if (response.status >= 200 && response.status < 300) return;
    } catch {
      // Server startup is asynchronous.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`预览测试服务器未就绪：${url}`);
}

async function httpGet(url: string): Promise<{body: string; status: number}> {
  return new Promise((resolveResponse, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolveResponse({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode ?? 0,
        });
      });
    });
    request.once("error", reject);
  });
}
