import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import {
  ModelConfigurationRepository,
  ModelCredentialRepository,
} from "../apps/local-agent-host/src/model-config/repository.js";

const executablePath = process.env.OPENCRAFT_PACKAGED_PROJECTLESS_EXECUTABLE;
if (!executablePath) throw new Error("Set OPENCRAFT_PACKAGED_PROJECTLESS_EXECUTABLE");
const { _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = await mkdtemp("/tmp/opencraft-packaged-projectless-");
const modelDirectory = join(root, "models");
const projectlessRoot = join(root, "OpenCraft");
let requests = 0;
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw) as { stream?: boolean };
  if (!body.stream) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: "projectless-fixture",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, message: { role: "assistant", content: "projectless-package-ok" }, finish_reason: "stop" }],
    }));
    return;
  }
  requests += 1;
  const chunk = (delta: unknown, finishReason: string | null) => `data: ${JSON.stringify({
    id: "projectless-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
  response.setHeader("content-type", "text/event-stream");
  response.end(chunk({ role: "assistant", content: "projectless-package-ok" }, null)
    + chunk({}, "stop") + "data: [DONE]\n\n");
});

await new Promise<void>((resolveListen) => model.listen(0, "127.0.0.1", resolveListen));
const address = model.address();
if (address === null || typeof address === "string") throw new Error("Fixture model did not bind");
await new ModelCredentialRepository(modelDirectory).set("FIXTURE_KEY", "synthetic-only");
await new ModelConfigurationRepository(modelDirectory).initialize({
  schemaVersion: 1,
  revision: 0,
  providers: [{
    id: "fixture-provider",
    name: "Fixture",
    protocol: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    credentialRef: "FIXTURE_KEY",
    enabled: true,
    models: [{ id: "fixture", enabled: true }],
  }],
  defaultModel: { providerId: "fixture-provider", modelId: "fixture" },
});

const environment = {
  ...process.env,
  OPENCRAFT_HOME: join(root, "home"),
  OPENCRAFT_MODEL_STORAGE_DIRECTORY: modelDirectory,
  OPENCRAFT_PROJECTLESS_WORKSPACE_DIRECTORY: projectlessRoot,
  OPENCRAFT_SKILLS_DIRECTORY: join(root, "skills"),
  DSH_AGENTS_HOME: join(root, "agents"),
  CODEX_HOME: join(root, "codex"),
};
delete environment.ELECTRON_RUN_AS_NODE;
let desktop: any;
const pageErrors: string[] = [];
try {
  desktop = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(root, "profile")}`],
    env: environment,
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error: Error) => pageErrors.push(error.message));
  await page.locator('.workbench-connection-status[data-phase="ready"]').first().waitFor({
    state: "attached",
  });
  const editor = page.locator(".codex-composer-editor").first();
  await editor.fill("hello");
  await editor.press("Enter");
  await page.getByRole("paragraph")
    .filter({ hasText: "projectless-package-ok" })
    .last()
    .waitFor();
  assert.equal(await page.locator(".pending-conversation-error").count(), 0);
  assert.equal(requests > 0, true);
  const workspaces = await readdir(projectlessRoot, { withFileTypes: true });
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]?.isDirectory(), true);
  assert.match(workspaces[0]?.name ?? "", /^thread-[A-Za-z0-9._-]+$/u);
  await assert.rejects(access(join(modelDirectory, "projects.json")), { code: "ENOENT" });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    result: "passed",
    packaged: true,
    projectlessWorkspace: join(projectlessRoot, workspaces[0]!.name),
    modelRequests: requests,
  }));
} finally {
  await desktop?.close();
  model.closeAllConnections();
  await new Promise<void>((resolveClose) => model.close(() => resolveClose()));
  await rm(root, { recursive: true, force: true });
}
