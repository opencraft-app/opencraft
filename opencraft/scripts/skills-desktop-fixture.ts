import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../apps/local-agent-host/src/model-config/repository.js";
import { electronLaunchSpec } from "./start-electron.mjs";

// Manual desktop acceptance fixture. No user credentials, model calls or Skill
// writes leave this temporary root. Stop with Ctrl-C after capturing evidence.
// macOS Unix socket paths are limited to ~104 bytes; its per-user TMPDIR is
// too long once the daemon profile/socket suffix is appended.
const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "oc-skills-desktop-"));
const stats = { requests: 0, catalogSeen: false, bodySeen: false };
const endpoint = createServer(async (req, res) => {
  if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(stats)); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages ?? [];
  const hasCatalog = messages.some((m: any) => JSON.stringify(m.content).includes("desktop-refresh-fixture") && JSON.stringify(m.content).includes("<available_skills>"));
  const hasBody = messages.some((m: any) => m.role === "tool" && JSON.stringify(m.content).includes("DESKTOP_SKILL_BODY_SENTINEL"));
  if (body.stream) {
    stats.requests++;
    stats.catalogSeen ||= hasCatalog;
    stats.bodySeen ||= hasBody;
    await writeFile(join(root, "evidence.json"), JSON.stringify(stats));
  }
  const invoke = body.stream && hasCatalog && !hasBody;
  const answer = hasBody ? "已通过原生 Skill 工具读取新安装技能：DESKTOP_SKILL_BODY_SENTINEL" : "会话已建立。安装技能后在本会话继续。";
  const message = invoke ? { role: "assistant", tool_calls: [{ index: 0, id: "desktop-skill-load", type: "function", function: { name: "skill", arguments: JSON.stringify({ name: "desktop-refresh-fixture" }) } }] } : { role: "assistant", content: answer };
  const base = { id: "desktop-fixture", created: 1, model: "fixture" };
  if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }] })); return; }
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.setHeader("content-type", "text/event-stream");
  res.end(chunk(message, null) + chunk({}, invoke ? "tool_calls" : "stop") + "data: [DONE]\n\n");
});
await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
const port = (endpoint.address() as {port: number}).port;
const product = join(root, "models");
await new ModelCredentialRepository(product).set("DESKTOP_FIXTURE", "synthetic-only");
await new ModelConfigurationRepository(product).initialize({ schemaVersion: 1, revision: 0,
  providers: [{ id: "desktop-fixture", name: "Desktop fixture", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, credentialRef: "DESKTOP_FIXTURE", enabled: true, models: [{ id: "fixture", enabled: true }] }],
  defaultModel: { providerId: "desktop-fixture", modelId: "fixture" },
});
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const debugPort = (reservation.address() as {port: number}).port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
await mkdir(join(root, "workspace"));
const environment = { ...process.env, OPENCRAFT_MODEL_STORAGE_DIRECTORY: product, OPENCRAFT_SKILLS_DIRECTORY: join(root, "skills"), DSH_AGENTS_HOME: join(root, "agents") };
delete environment.OPENCRAFT_DSH_URL;
delete environment.OPENCRAFT_DSH_REPOSITORY;
const spec = electronLaunchSpec([`--user-data-dir=${join(root, "profile")}`, `--remote-debugging-port=${debugPort}`], environment);
const packagedExecutable = process.env.OPENCRAFT_SKILLS_PREVIEW_EXECUTABLE;
const child = spawn(packagedExecutable ?? spec.executable, packagedExecutable ? spec.args.slice(1) : spec.args, spec.options);
console.log(JSON.stringify({ root, debugPort, modelPort: port, electronPid: child.pid }));
process.once("SIGINT", () => child.kill("SIGTERM"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("exit", () => { endpoint.closeAllConnections(); endpoint.close(); });
