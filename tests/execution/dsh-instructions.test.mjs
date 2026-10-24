import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "../../runtime/dsh/node_modules/@deepseek-ai/cordis/lib/index.js";
import { createScope, bindScopeParent, scopeOf } from "../../runtime/dsh/node_modules/@deepseek-ai/dsh-scope/lib/index.js";
import { SystemPrompt, renderPrompt, PERSONA_SECTION, PERSONA_ORDER } from "../../runtime/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js";
import { Session, SessionId } from "../../runtime/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js";
import { createThreadEngine } from "../../apps/local-agent-host/src/dsh-thread-engine.mjs";
import { instructionOverrides, sessionInstructions, registerInstructionEvents } from "../../apps/local-agent-host/src/dsh-instructions.mjs";

test("instructions validate values, keep omitted/null choices and preserve explicit empty strings", () => {
  assert.deepEqual(instructionOverrides({ baseInstructions: null, developerInstructions: "" }), { developerInstructions: "" });
  assert.throws(() => instructionOverrides({ baseInstructions: 1 }), /must be a string/);
});

test("owned event vocabulary registration is scoped and does not admit unrelated unknown events", async () => {
  const a = new Context(), b = new Context();
  const known = new Set(["assistant/message"]);
  registerInstructionEvents(a, known); registerInstructionEvents(b, known);
  assert.ok(known.has("opencraft/instructions"));
  assert.equal(known.has("unknown/required"), false);
  await a.fiber.dispose(); assert.ok(known.has("opencraft/instructions"));
  await b.fiber.dispose(); assert.equal(known.has("opencraft/instructions"), false);
});

test("native scoped prompt sections survive loaded/cold resume and bounded forks without cross-thread leakage", async () => {
  const root = new Context();
  await root.plugin(SystemPrompt, { persona: "global persona", includeHarnessIdentity: false });
  let ctx;
  await root.plugin({ inject: ["systemPrompt"],
    apply(owner) { ctx = owner; } });
  const presetKey = {};
  const preset = createScope(ctx, presetKey);
  preset.ctx.systemPrompt.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: "preset persona" });
  preset.ctx.systemPrompt.section({ name: "fixture:tools", order: 20, text: "tool instructions" });
  const live = new Map(), stored = new Map();
  let activations = 0;
  const flush = async session => stored.set(String(session.id), { meta: structuredClone(session.header), events: structuredClone(session.events) });
  const publish = async (options, resume = false) => {
    activations++;
    const id = options.sessionId ?? options.resumeSessionId;
    const saved = stored.get(String(id));
    const session = resume ? Session.fromRestore(id, saved.events, saved.meta)
      : Session.create(id, options.seed, { version: 0, createdAt: 1, ...options.meta, id });
    const key = {}, owner = createScope(ctx, key);
    const agent = { session, status: "idle", ctx: owner.ctx };
    const child = owner.ctx.extend({ agent });
    agent.ctx = child;
    await options.setup(child);
    const handle = { agent, key, async dispose() { live.delete(String(id)); await owner.dispose(); } };
    live.set(String(id), handle);
    return handle;
  };
  // Only the Agent factory/persistence I/O boundary is replaced. Session
  // acceptance, scope inheritance and prompt assembly use the locked runtime.
  ctx.provide("agents", { get: id => live.get(String(id))?.agent,
    create: options => publish(options), resume: options => publish(options, true) });
  ctx.provide("agentPresets", { resolve: async id => ({ id: id ?? "standard" }),
    mount: async (child, id) => { assert.equal(id, "standard"); bindScopeParent(scopeOf(child), presetKey); } });
  ctx.provide("sessions", { flush });
  ctx.provide("goals", { get: () => undefined });
  ctx.provide("jobs", { list: () => [] });
  ctx.provide("sessionPersistence", { inspect: async id => stored.get(String(id)) });
  ctx.provide("sandboxPolicy", { resolve: () => ({ mode: "workspace-write" }) });
  ctx.provide("approval", { overrideOf: () => "ask" });
  ctx.provide("permissionPresets", { current: () => undefined });
  const engine = await createThreadEngine(ctx, new URL("../../runtime/dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js", import.meta.url).href);
  const prompt = async id => renderPrompt(await ctx.systemPrompt.assemble({ scope: live.get(id).key }));
  try {
    await engine.create({ sessionId: "a", cwd: "/workspace", baseInstructions: "custom base", developerInstructions: "first developer" });
    assert.equal(await prompt("a"), "custom base\n\ntool instructions\n\nfirst developer");
    await engine.create({ sessionId: "b", cwd: "/other" });
    assert.equal(await prompt("b"), "preset persona\n\ntool instructions");
    stored.set("legacy", { meta: { version: 0, createdAt: 1, id: "legacy", cwd: "/workspace", agentPreset: "standard" }, events: [] });
    await engine.resume({ sessionId: "legacy", legacyInstructions: { developerInstructions: "legacy developer" } });
    assert.equal(await prompt("legacy"), "preset persona\n\ntool instructions\n\nlegacy developer");
    await engine.resume({ sessionId: "legacy", developerInstructions: "new developer" });
    await engine.resume({ sessionId: "legacy", legacyInstructions: { developerInstructions: "legacy developer" } });
    assert.equal(await prompt("legacy"), "preset persona\n\ntool instructions\n\nnew developer");
    await publish({ sessionId: SessionId("native-loaded"), meta: { cwd: "/workspace" },
      setup: child => ctx.agentPresets.mount(child, "standard") });
    await engine.resume({ sessionId: "native-loaded", developerInstructions: "borrowed scope developer" });
    assert.equal(await prompt("native-loaded"), "preset persona\n\ntool instructions\n\nborrowed scope developer");
    await engine.resume({ sessionId: "a", baseInstructions: null, developerInstructions: "second developer" });
    assert.equal(activations, 4, "loaded update never recreates the Agent");
    assert.equal(await prompt("a"), "custom base\n\ntool instructions\n\nsecond developer");
    const before = live.get("a").agent.session.events.length;
    await engine.resume({ sessionId: "a", developerInstructions: "second developer" });
    assert.equal(live.get("a").agent.session.events.length, before, "idempotent resume does not grow history");
    await engine.release({ sessionId: "a" });
    await Promise.all([engine.resume({ sessionId: "a" }), engine.resume({ sessionId: "a", developerInstructions: "second developer" })]);
    assert.equal(await prompt("a"), "custom base\n\ntool instructions\n\nsecond developer");
    live.get("a").agent.session.append("turn/start", { turn: 1 });
    await engine.resume({ sessionId: "a", developerInstructions: "later developer" });
    live.get("a").agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await engine.fork({ sourceSessionId: "a", sessionId: "bounded", beforeTurn: 1 });
    assert.equal(await prompt("bounded"), "custom base\n\ntool instructions\n\nsecond developer");
    await engine.resume({ sessionId: "a", developerInstructions: "second developer" });
    const fork = await engine.fork({ sourceSessionId: "a", sessionId: "child", developerInstructions: "child developer" });
    assert.equal(fork.sessionId, "child");
    assert.equal(await prompt("child"), "custom base\n\ntool instructions\n\nchild developer");
    assert.equal(await prompt("a"), "custom base\n\ntool instructions\n\nsecond developer");
    await engine.resume({ sessionId: "a", baseInstructions: "", developerInstructions: "" });
    assert.equal(await prompt("a"), "tool instructions");
    await engine.release({ sessionId: "a" });
    await engine.resume({ sessionId: "a" });
    assert.equal(await prompt("a"), "tool instructions");
    const settings = sessionInstructions(live.get("a").agent.session);
    assert.deepEqual(settings, { baseInstructions: "", developerInstructions: "" });
    await engine.resume({ sessionId: "a", baseInstructions: "Use {{literal}}", developerInstructions: "Keep {{invalid native variable}}" });
    assert.equal(await prompt("a"), "Use {{literal}}\n\ntool instructions\n\nKeep {{invalid native variable}}");
    assert.equal(live.get("a").agent.session.events.some(event => event.type === "user/message"), false);
    assert.equal(await prompt("b"), "preset persona\n\ntool instructions");
  } finally { await root.fiber.dispose(); }
});
