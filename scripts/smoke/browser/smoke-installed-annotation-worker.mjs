// Packaged Hands acceptance; uses an isolated profile and a local fixture, never production data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
const root = await mkdtemp(join(tmpdir(), "installed-annotation-"));
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(
    '<!doctype html><style>body{margin:0;height:2000px}button{position:absolute;left:100px;top:100px;width:200px;height:80px}</style><button id="target">Installed target</button>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const child = spawn(
  "/opt/opencraft/runtime/browser/electron/electron",
  [
    "--no-sandbox",
    "--ozone-platform=headless",
    "--ozone-override-screen-size=1920,1080",
    "--disable-gpu",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
    "/opt/opencraft/runtime/browser/worker.cjs",
  ],
  {
    env: {
      ...process.env,
      OPENCRAFT_BROWSER_DATA_DIR: root,
      ELECTRON_RUN_AS_NODE: "",
      HOME: root,
      XDG_CACHE_HOME: root,
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let control;
let seq = 0,
  log = "",
  readyResolve,
  readyReject;
const pending = new Map();
const ready = new Promise((r, j) => {
  readyResolve = r;
  readyReject = j;
});
child.once("exit", (code) => {
  readyReject(Error("Worker exited " + code + " " + log));
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(Error("Worker exited " + code));
  }
  pending.clear();
});
child.stderr.on("data", (v) => {
  log = (log + v).slice(-8000);
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === "ready") readyResolve();
  if (m.type === "result" && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(Object.assign(Error(m.error.message), { code: m.error.code })) : p.resolve(m.value);
  }
});
const call = (method, input = {}, document) =>
  new Promise((resolve, reject) => {
    const id = ++seq,
      timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Worker timeout " + method + " " + log));
      }, 12000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(
      JSON.stringify({
        id,
        page: "polish-smoke",
        method,
        input,
        ...(document ? { document } : {}),
        ...(control ? { control } : {}),
      }) + "\n",
    );
  });
const until = async (f) => {
  let error;
  for (let i = 0; i < 50; i++) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      error = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw error ?? Error("Condition timeout");
};
const timeout = setTimeout(() => {
  console.error("Installed worker global timeout " + log);
  child.kill("SIGKILL");
  process.exit(1);
}, 45000);
try {
  await ready;
  await call("create", { width: 800, height: 600 });
  await call("navigate", { url: "http://127.0.0.1:" + server.address().port + "/" });
  await until(async () =>
    String((await call("automation", { method: "readContext" })).content).includes("Installed target"),
  );
  await call("visible", { visible: true });
  const doc = (await call("snapshot")).document;
  const auto = (method, input) => call("automation", { method, input }, doc);
  const pick = await auto("annotatePick", { point: { x: 150, y: 140, frameWidth: 800, frameHeight: 600 } });
  assert.equal(pick.anchor.tag, "button");
  assert.ok(pick.anchor.bindingKey);
  const styles = await auto("annotateStyles", pick.anchor);
  assert.ok(styles);
  await call(
    "annotation-overlay",
    {
      type: "boxes",
      boxes: [
        {
          ...pick.anchor.rect,
          targetKey: pick.anchor.bindingKey,
          documentGeneration: pick.anchor.documentGeneration,
          markerId: "annotation/target",
          state: "current",
          kind: "element",
          label: "1A",
        },
      ],
    },
    doc,
  );
  assert.deepEqual(
    await call(
      "annotation-overlay",
      { type: "hit", point: { x: 298, y: 102, frameWidth: 800, frameHeight: 600 } },
      doc,
    ),
    ["annotation/target"],
  );
  await assert.rejects(auto("annotatePreview", { changes: [{ anchor: pick.anchor, text: "Not authorized" }] }), {
    code: "CONTROL_LOST",
  });
  const grant = "annotation-control-0123456789";
  await call("control", { token: grant }, doc);
  control = grant;
  await auto("annotatePreview", { changes: [{ anchor: pick.anchor, text: "Installed preview" }] });
  assert.match((await auto("readContext")).content, /Installed preview/);
  await call("control", { token: null }, doc);
  control = undefined;
  assert.match((await auto("readContext")).content, /Installed target/);
  await assert.rejects(auto("annotatePreview", { changes: [{ anchor: pick.anchor, text: "Retired grant" }] }), {
    code: "CONTROL_LOST",
  });
  assert.match(await call("capture", {}, doc), /^data:image\/png;base64,/);
  await call("annotation-overlay", { type: "clear" }, doc);
  assert.deepEqual(
    await call(
      "annotation-overlay",
      { type: "hit", point: { x: 298, y: 102, frameWidth: 800, frameHeight: 600 } },
      doc,
    ),
    [],
  );
  await call("navigate", { url: "http://127.0.0.1:" + server.address().port + "/next" });
  await until(async () => (await call("snapshot")).document !== doc);
  await assert.rejects(call("annotation-overlay", { type: "clear" }, doc), { code: "DOCUMENT_CHANGED" });
  await call("close");
  console.log(
    JSON.stringify({
      ok: true,
      installedWorker: true,
      pick: true,
      styles: true,
      markerHit: true,
      previewRestore: true,
      missingGrantRejected: true,
      controlLossRestores: true,
      capture: true,
      clear: true,
      staleDocumentRejected: true,
    }),
  );
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      r();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(t);
      r();
    });
  });
  lines.close();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
