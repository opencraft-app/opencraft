import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { LocalCredentialVault } from "../src/adapters/local/credential-vault.mjs";
import { request } from "../src/runner.mjs";
import {
  profileFor,
  running,
  until,
  completed,
  childRunner,
  nativeEntries,
} from "./helpers.mjs";
const make = (app, kind, options = {}) => {
  const { workId } = app.works.submit(`work-${kind}`, { text: `wait ${kind}` });
  const work = app.workRecord(workId);
  const interaction = app.interactions.request(
    work,
    `call-${kind}`,
    "Need owner intervention",
    { kind, provider: "service", ...options },
  );
  return { work, interaction };
};

test("secret values are encrypted locally; wrong provider/kind and plaintext resolution are rejected", (t) => {
  const profile = profileFor(t),
    store = new Store(profile);
  t.after(() => store.close());
  const { app } = store,
    { work, interaction } = make(app, "secret");
  const vault = new LocalCredentialVault(profile),
    marker = "sensitive-marker-should-never-reach-core";
  const wrong = vault.put("wrong", "authorization", "service", marker);
  assert.throws(
    () =>
      app.interactions.resolve("wrong", {
        interactionId: interaction.id,
        expectedRevision: 1,
        credentialRef: wrong.reference,
      }),
    /kind\/provider/,
  );
  assert.throws(
    () =>
      app.interactions.resolve("text", {
        interactionId: interaction.id,
        expectedRevision: 1,
        text: marker,
      }),
    /never chat/,
  );
  assert.throws(
    () =>
      app.interactions.answer("plain", {
        interactionId: interaction.id,
        expectedRevision: 1,
        text: marker,
      }),
    /typed/,
  );
  assert.equal(app.r.inputs.get("text"), undefined);
  assert.equal(app.r.inputs.get("plain"), undefined);
  const credential = vault.put("correct", "secret", "service", marker);
  assert.equal(
    vault.put("correct", "secret", "service", marker).reference,
    credential.reference,
  );
  assert.throws(
    () => vault.put("correct", "secret", "service", "changed"),
    /different/,
  );
  app.interactions.resolve("resolve", {
    interactionId: interaction.id,
    expectedRevision: 1,
    credentialRef: credential.reference,
  });
  assert.equal(app.workRecord(work.id).status, "queued");
  assert.equal(
    JSON.parse(app.interactions.list()[0].answer).credentialRef,
    credential.reference,
  );
  assert.equal(JSON.stringify(app.events()).includes(marker), false);
  assert.equal(
    readFileSync(join(profile.path, "assistant.sqlite")).includes(
      Buffer.from(marker),
    ),
    false,
  );
  assert.equal(
    readFileSync(
      join(profile.path, "credentials", `${credential.reference}.json`),
      "utf8",
    ).includes(marker),
    false,
  );
  assert.equal(
    statSync(join(profile.path, "credentials", "key")).mode & 0o777,
    0o600,
  );
});

test("authorization and handoff return typed receipts without claiming external verification", (t) => {
  const profile = profileFor(t),
    store = new Store(profile);
  t.after(() => store.close());
  const { app } = store;
  const auth = make(app, "authorization"),
    vault = new LocalCredentialVault(profile);
  const ref = vault.put(
    "auth",
    "authorization",
    "service",
    "user-supplied-token",
  ).reference;
  app.interactions.resolve("auth-complete", {
    interactionId: auth.interaction.id,
    expectedRevision: 1,
    credentialRef: ref,
  });
  const authAnswer = JSON.parse(
    app.interactions.list().find((i) => i.kind === "authorization").answer,
  );
  assert.equal(authAnswer.verification, "owner-provided");
  const handoff = make(app, "handoff");
  app.interactions.resolve("handoff-complete", {
    interactionId: handoff.interaction.id,
    expectedRevision: 1,
    text: "I completed the local action",
  });
  const answer = JSON.parse(
    app.interactions.list().find((i) => i.kind === "handoff").answer,
  );
  assert.equal(answer.verification, "owner-reported");
  assert.equal(answer.report, "I completed the local action");
  const duplicate = app.interactions.resolve("handoff-complete", {
    interactionId: handoff.interaction.id,
    expectedRevision: 1,
    text: "I completed the local action",
  });
  assert.equal(duplicate.duplicate, true);
});

test("expired, cancelled and superseded interventions cannot resume a work", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store;
  const expired = make(app, "handoff", { expiresInMs: 1000 });
  app.interactions.now = () => Date.now() + 2000;
  app.interactions.expire();
  assert.equal(app.interactions.list()[0].state, "expired");
  assert.equal(app.workRecord(expired.work.id).status, "blocked");
  assert.throws(
    () =>
      app.interactions.resolve("late", {
        interactionId: expired.interaction.id,
        expectedRevision: 1,
        text: "done",
      }),
    /expired/,
  );
  app.interactions.now = Date.now;
  const cancelled = make(app, "secret");
  app.works.cancel("cancel", {
    workId: cancelled.work.id,
    expectedRevision: 1,
  });
  assert.throws(
    () =>
      app.interactions.resolve("cancelled", {
        interactionId: cancelled.interaction.id,
        expectedRevision: 1,
        credentialRef: "0".repeat(64),
      }),
    /cancelled/,
  );
  const superseded = make(app, "authorization");
  app.works.amend("amend", {
    workId: superseded.work.id,
    expectedRevision: 1,
    text: "different task",
  });
  assert.throws(
    () =>
      app.interactions.resolve("superseded", {
        interactionId: superseded.interaction.id,
        expectedRevision: 1,
        credentialRef: "0".repeat(64),
      }),
    /superseded/,
  );
});

test("credential expiry and cross-owner profile prevent credential reuse", (t) => {
  const profile = profileFor(t),
    vault = new LocalCredentialVault(profile);
  const ref = vault.put("ttl", "secret", "service", "secret").reference;
  const expired = new LocalCredentialVault(profile, () => Date.now() + 1800001);
  assert.throws(() => expired.describe(ref), /expired/);
  const other = new LocalCredentialVault({
    ...profile,
    config: { ...profile.config, owner: "another-owner" },
  });
  assert.throws(() => other.describe(ref), /unavailable/);
  assert.throws(() => vault.describe("../key"), /unavailable/);
});

test("Pi native intervention survives a crash and CLI secure input resumes the same submission without plaintext", async (t) => {
  const profile = profileFor(t),
    first = await childRunner(t, profile, {
      LAB_TEST_CRASH_AT: "interaction-saved-before-suspend",
    });
  const receipt = await request(profile, {
    op: "submit",
    id: "native-secret",
    params: { text: "Write a note [wait:secret]" },
  });
  assert.equal((await first.exited).code, 86);
  const second = await childRunner(t, profile);
  const [pending] = await request(profile, {
    op: "interaction.list",
    params: {},
  });
  assert.equal(pending.kind, "secret");
  const marker = "native-secret-must-not-appear-in-transcripts";
  const file = join(profile.path, "owner-provided-input.txt");
  writeFileSync(file, marker, { mode: 0o600 });
  const cli = await promisify(execFile)(process.execPath, [
    "bin/assistant.mjs",
    "provide-secret",
    "--profile",
    profile.path,
    "--interaction",
    pending.id,
    "--revision",
    "1",
    "--secret-file",
    file,
  ]);
  assert.equal(cli.stdout.includes(marker), false);
  assert.equal(cli.stderr.includes(marker), false);
  await completed(profile, receipt.workId);
  await second.stop();
  const entries = await nativeEntries(profile, receipt.workId);
  assert.equal(JSON.stringify(entries).includes(marker), false);
  assert.ok(JSON.stringify(entries).includes("credentialRef"));
  assert.equal(
    readFileSync(join(profile.path, "assistant.sqlite")).includes(
      Buffer.from(marker),
    ),
    false,
  );
});

for (const kind of ["authorization", "handoff"])
  test(`Pi ${kind} suspends without occupying a worker and resumes through its typed path`, async (t) => {
    const { profile, call } = await running(t, { concurrency: 1 });
    const receipt = await call("submit", {
      text: `Write a note [wait:${kind}]`,
    });
    const interaction = await until(async () =>
      (await call("interaction.list")).find((i) => i.kind === kind),
    );
    await until(async () => (await call("status")).active === 0);
    const params = { interactionId: interaction.id, expectedRevision: 1 };
    if (kind === "handoff") params.text = "Done by owner";
    else
      params.credentialRef = new LocalCredentialVault(profile).put(
        "provided",
        kind,
        "test-service",
        "test-token",
      ).reference;
    await call("interaction.resolve", params);
    await completed(profile, receipt.workId);
  });

test("main conversation identifies typed waiting and guides secure input without answering it", async (t) => {
  const { runner, call } = await running(t);
  const receipt = runner.app.works.submit("typed-main", { text: "a task" });
  runner.app.history.link(runner.app.history.main.id, receipt.workId);
  const work = runner.app.workRecord(receipt.workId);
  runner.app.interactions.request(work, "typed-call", "Need secure input", {
    kind: "secret",
    provider: "service",
  });
  const question = runner.app.history
    .view()
    .messages.find((m) => m.data.kind === "question");
  assert.match(question.text, /provide-secret/);
  await call("say", { text: "回答：已准备好" }, "typed-response");
  await until(() => {
    const turn = runner.app.reception.turn("typed-response");
    assert.notEqual(turn.status, "blocked", turn.reply_text);
    return turn.status === "settled";
  });
  assert.match(
    runner.app.reception.turn("typed-response").reply_text,
    /专用命令/,
  );
  assert.equal(runner.app.interactions.list()[0].state, "pending");
});
