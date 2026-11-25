import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  loadPreviewState,
  reconcilePreviews,
  replacePreview,
  savePreviewState,
  type PreviewState,
} from "../../scripts/cloudflare/preview-state.ts";

const accountId = "a".repeat(32);
const preview = (id: string) => {
  const worker = "opencraft-preview-cf-" + id.repeat(8);
  return { worker, origin: "https://" + worker + ".example.workers.dev" };
};
const active = preview("a");
const candidate = preview("b");
const image = "registry.cloudflare.com/" + accountId + "/bridge@sha256:" + "a".repeat(64);
const account = { username: "preview", password: "existing-password" } as const;

async function harness(context: TestContext, fixedAddress = false) {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-preview-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const state: PreviewState = {
    accountId,
    ...account,
    image,
    active,
    pending: [],
    ...(fixedAddress
      ? { publicOrigin: "https://opencraft-preview.example.workers.dev", customOrigin: "https://preview.example.com" }
      : {}),
  };
  await savePreviewState(path, state);
  const apps = new Map([
    ["a".repeat(32), active.worker],
    ["b".repeat(32), candidate.worker],
  ]);
  const workers = new Set([active.worker, candidate.worker, active.worker + "-model", candidate.worker + "-model"]);
  const queues = new Map([["c".repeat(32), active.worker + "-verify"]]);
  const deleted: string[] = [];
  let failOldModelDeletion = false;
  let route = active;
  let failRoute = false;
  const api = {
    accountId,
    listWorkers: async () => [...workers],
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (path === "/workers/scripts/opencraft-preview/settings")
        return {
          bindings: [
            { type: "plain_text", name: "PREVIEW_PUBLIC_ORIGIN", text: state.publicOrigin },
            { type: "plain_text", name: "PREVIEW_CUSTOM_ORIGIN", text: state.customOrigin },
            { type: "plain_text", name: "PREVIEW_TARGET_ORIGIN", text: route.origin },
            { type: "service", name: "PREVIEW_TARGET", service: route.worker },
          ],
        } as T;
      if (path === "/workers/scripts/opencraft-preview/subdomain") return { enabled: true } as T;
      if (method === "PUT" && path === "/workers/scripts/opencraft-preview") {
        if (failRoute) throw Error("Temporary failure switching the fixed address");
        assert.ok(body instanceof FormData);
        const metadata = JSON.parse(await (body.get("metadata") as Blob).text());
        assert.equal(metadata.bindings.find((binding) => binding.name === "PREVIEW_TARGET").service, candidate.worker);
        assert.equal(
          metadata.bindings.find((binding) => binding.name === "PREVIEW_CUSTOM_ORIGIN").text,
          state.customOrigin,
        );
        route = candidate;
        return {} as T;
      }
      if (method === "GET" && path === "/containers/applications")
        return [...apps].map(([id, name]) => ({ id, name })) as T;
      if (method === "GET" && path.startsWith("/queues?name="))
        return [...queues].map(([queue_id, queue_name]) => ({ queue_id, queue_name })) as T;
      assert.equal(method, "DELETE");
      if (fixedAddress) assert.equal(route.worker, candidate.worker, "Old preview retired before cutover");
      deleted.push(path);
      if (path.startsWith("/queues/")) queues.delete(path.split("/").at(-1)!);
      else if (path.startsWith("/containers/applications/")) apps.delete(path.split("/").at(-1)!);
      else if (path.startsWith("/workers/scripts/") && path.endsWith("?force=true")) {
        const worker = path.split("/").at(-1)!.split("?")[0]!;
        if (failOldModelDeletion && worker === active.worker + "-model")
          throw Error("Simulated Cloudflare deletion failure");
        if (!workers.delete(worker)) throw Object.assign(Error("Absent"), { status: 404 });
      } else assert.fail("Unexpected route " + path);
      return null as T;
    },
  };
  return {
    path,
    state,
    api,
    workers,
    apps,
    queues,
    deleted,
    load: () => loadPreviewState(path, accountId, "example"),
    failOldModel: (fail: boolean) => {
      failOldModelDeletion = fail;
    },
    failAddress: (fail: boolean) => {
      failRoute = fail;
    },
    routedTo: () => route.worker,
  };
}

test("verified replacement registers the new address before retiring the old one and reuses credentials", async (context) => {
  const fixture = await harness(context);
  await replacePreview(fixture.api, fixture.path, fixture.state, candidate, image, async () => {
    const staging = await fixture.load();
    assert.equal(staging.active.worker, active.worker);
    assert.deepEqual(staging.pending, [candidate]);
    assert.equal(fixture.deleted.length, 0);
    assert.equal(staging.password, account.password);
  });
  assert.deepEqual(await fixture.load(), { accountId, ...account, image, active: candidate, pending: [] });
  assert.deepEqual([...fixture.workers], [candidate.worker, candidate.worker + "-model"]);
  assert.deepEqual([...fixture.apps.values()], [candidate.worker]);
  assert.deepEqual([...fixture.queues], []);
});

test("an old preview journal loads without retaining the deployment deadline", async (context) => {
  const fixture = await harness(context);
  const oldActive = { ...active, expires: 1 };
  await savePreviewState(fixture.path, { ...fixture.state, active: oldActive });
  const loaded = await fixture.load();
  assert.deepEqual(loaded.active, active);
  assert.equal(loaded.password, account.password);
  await savePreviewState(fixture.path, loaded);
  assert.doesNotMatch(await readFile(fixture.path, "utf8"), /"expires"/u);
});

test("failed candidate verification removes its resources and keeps the active deployment", async (context) => {
  const fixture = await harness(context);
  await assert.rejects(
    replacePreview(fixture.api, fixture.path, fixture.state, candidate, image, async () => {
      throw Error("Failed login");
    }),
    /Failed login/,
  );
  assert.deepEqual(await fixture.load(), fixture.state);
  assert.deepEqual([...fixture.workers], [active.worker, active.worker + "-model"]);
  assert.deepEqual([...fixture.apps.values()], [active.worker]);
  assert.deepEqual([...fixture.queues.values()], [active.worker + "-verify"]);
});

test("a partially retired deployment remains in the journal and a retry keeps the new active preview", async (context) => {
  const fixture = await harness(context);
  fixture.failOldModel(true);
  await assert.rejects(
    replacePreview(fixture.api, fixture.path, fixture.state, candidate, image, async () => {}),
    /Simulated Cloudflare deletion failure/,
  );
  const state = await fixture.load();
  assert.deepEqual(state.active, candidate);
  assert.deepEqual(state.pending, [active]);
  fixture.failOldModel(false);
  await reconcilePreviews(fixture.api, fixture.path, state);
  assert.deepEqual(await fixture.load(), { ...state, pending: [] });
  assert.deepEqual([...fixture.workers], [candidate.worker, candidate.worker + "-model"]);
});

test("a verified candidate is retained when cutover fails; cleanup resumes after the fixed address switches", async (context) => {
  const fixture = await harness(context, true);
  fixture.failAddress(true);
  await assert.rejects(
    replacePreview(fixture.api, fixture.path, fixture.state, candidate, image, async () => {}),
    /Temporary failure switching/,
  );
  const journal = await fixture.load();
  assert.equal(journal.active.worker, candidate.worker);
  assert.deepEqual(journal.pending, [active]);
  assert.equal(fixture.routedTo(), active.worker);
  assert.deepEqual(fixture.deleted, []);
  fixture.failAddress(false);
  await reconcilePreviews(fixture.api, fixture.path, journal);
  assert.equal(fixture.routedTo(), candidate.worker);
  assert.deepEqual([...fixture.workers], [candidate.worker, candidate.worker + "-model"]);
  assert.deepEqual((await fixture.load()).pending, []);
});
