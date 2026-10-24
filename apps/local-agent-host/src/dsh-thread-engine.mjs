import { randomUUID } from "node:crypto";
import { volatileSessions } from "./dsh-thread-storage.mjs";
import { instructionOverrides, sessionInstructions, createInstructionController, registerInstructionEvents } from "./dsh-instructions.mjs";

export function requireThreadWorkspaceCwd(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Native Thread creation requires an explicit workspace cwd");
  }
  return value;
}

export function forkSeed(source, { lastTurn, beforeTurn } = {}, closers) {
  if (lastTurn !== undefined && beforeTurn !== undefined) throw new Error("Fork boundaries are mutually exclusive");
  let selected = source;
  if (lastTurn !== undefined) {
    const start = source.find(e => e.type === "turn/start" && e.data.turn === lastTurn);
    const end = source.find(e => e.type === "turn/end" && e.data.turn === lastTurn);
    if (!start) throw new Error("Unknown fork turn");
    if (!end) throw new Error("Cannot fork through a turn in progress");
    selected = source.slice(0, source.indexOf(end) + 1);
  } else if (beforeTurn !== undefined) {
    const index = source.findIndex(e => e.type === "turn/start" && e.data.turn === beforeTurn);
    if (index < 0) throw new Error("Unknown fork turn");
    selected = source.slice(0, index);
  }
  // DSH events are deep-frozen at acceptance and the child Session snapshots
  // every seed event on construction, so a shallow array copy suffices here —
  // structuredClone of the whole history was a redundant third full deep copy.
  const detached = selected.slice();
  return [...detached, ...closers(detached)];
}

/** Native ownership and full event seeding; no renderer projection enters this port. */
export async function createThreadEngine(ctx, toolsModuleUrl, capabilities, instructionController) {
  const module = path => new URL(path, toolsModuleUrl).href;
  const { SessionId, interruptedTurnClosers, KNOWN_SESSION_EVENT_TYPES } = await import(module("../../dsh-session/lib/index.js"));
  registerInstructionEvents(ctx, KNOWN_SESSION_EVENT_TYPES);
  const { createUserMessage } = await import(module("../../dsh-llm/lib/index.js"));
  const { setSandboxMode } = await import(module("../../dsh-sandbox-policy/lib/index.js"));
  const { setApprovalPolicy } = await import(module("../../dsh-user-approval/lib/index.js"));
  const promptSlots = await import(module("../../dsh-system-prompt/lib/index.js"));
  const instructions = instructionController ?? createInstructionController(promptSlots);
  const handles = new Map();
  const resuming = new Map();
  const setup = input => async child => {
    const agentPreset = (await ctx.agentPresets.resolve(input.agentPreset ?? child.agent.session.header.agentPreset)).id;
    await ctx.agentPresets.mount(child, agentPreset);
    instructions.setup(child, input);
    if (input.permissionPreset && input.permissionPreset !== "custom") ctx.permissionPresets.set(child.agent.session, input.permissionPreset);
    if (input.permissionState) {
      setSandboxMode(child.agent.session, input.permissionState.mode);
      setApprovalPolicy(child.agent.session, input.permissionState.approval);
    }
    await capabilities?.mount({ ...input, agentPreset }, child.agent);
  };
  const create = async input => {
    const instructions = instructionOverrides(input);
    const sessionId = input.sessionId ?? randomUUID();
    if (input.ephemeral) volatileSessions.mark(sessionId);
    const agentPreset = (await ctx.agentPresets.resolve(input.agentPreset)).id;
    const cwd = requireThreadWorkspaceCwd(input.cwd);
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId(sessionId),
        seed: input.seed,
        meta: { cwd, agentPreset, opencraftInstructions: instructions,
          ...(input.sourceSessionId ? { parentSession: SessionId(input.sourceSessionId), seedLength: input.seed.length } : {}) },
        agentOptions: { ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) },
        setup: setup({ ...input, sessionId, agentPreset }) });
      handles.set(sessionId, handle);
      if (handle.agent.session.events.length === 0) handle.agent.session.append("session/end-seed", {});
      await ctx.sessions.flush(handle.agent.session);
      return { sessionId, agentPreset, cwd: handle.agent.session.header.cwd, ephemeral: input.ephemeral === true };
    } catch (error) {
      await capabilities?.rollback(sessionId);
      const handle = handles.get(sessionId);
      if (handle) { await handle.dispose(); handles.delete(sessionId); }
      if (input.ephemeral) volatileSessions.forget(sessionId);
      throw error;
    }
  };
  ctx.effect(() => async () => {
    for (const [id, handle] of handles) { await handle.dispose(); volatileSessions.forget(id); }
    handles.clear();
  });
  return {
    create,
    async goal(input) {
      const agent = ctx.agents.get(input.sessionId);
      if (!agent) {
        if (input.operation === "get") return { goal: null, loaded: false };
        throw new Error("Goal mutation requires a loaded thread");
      }
      let goal = ctx.goals.get(agent);
      if (input.operation === "get") return { goal: goal ?? null, loaded: true };
      if (input.tokenBudget != null) throw new Error("DSH does not support goal token budgets");
      const ref = () => ({ id: goal.id, revision: goal.revision });
      if (input.operation === "clear") {
        if (goal) ctx.goals.clear(agent, ref());
        await ctx.sessions.flush(agent.session);
        return { cleared: !!goal };
      }
      if (input.operation !== "set") throw new Error("Unknown goal operation");
      const status = input.status;
      if (status != null && !["active", "paused", "blocked", "complete"].includes(status)) throw new Error("Unsupported DSH goal status");
      if (input.objective != null && (typeof input.objective !== "string" || !input.objective.trim())) throw new Error("Goal objective must be non-empty");
      if (!goal || (goal.phase === "complete" && status === "active" && input.objective != null)) {
        if (typeof input.objective !== "string") throw new Error("A new goal requires an objective");
        // Create arms immediately. Do not partially create an unsupported state.
        if (status != null && status !== "active") throw new Error("A new goal must be active");
        goal = ctx.goals.create(agent, { objective: input.objective });
      } else {
        if (status === "active" && goal.phase === "complete") throw new Error("A completed goal requires a new objective");
        if (status === "paused" && !["active", "paused"].includes(goal.phase)) throw new Error("Only an active goal can be paused");
        if (status === "blocked" && !["active", "blocked"].includes(goal.phase)) throw new Error("Only an active goal can be blocked");
        if (input.objective != null && input.objective !== goal.objective) goal = ctx.goals.edit(agent, ref(), { objective: input.objective });
        if (status === "active" && (goal.phase !== "active" || goal.activation !== "armed")) goal = ctx.goals.resume(agent, ref());
        else if (status === "paused" && goal.phase !== "paused") goal = ctx.goals.pause(agent, ref());
        else if (status === "complete" && goal.phase !== "complete") goal = ctx.goals.complete(agent, ref());
        else if (status === "blocked" && goal.phase !== "blocked") goal = ctx.goals.block(agent, ref(), { code: "human-blocked", message: "Goal blocked by the user." });
      }
      await ctx.sessions.flush(agent.session);
      return { goal };
    },
    async describe(input) {
      const live = ctx.agents.get(input.sessionId)?.session;
      const stored = live ? { meta: live.header, events: live.events } : await ctx.sessionPersistence.inspect(SessionId(input.sessionId));
      const session = live ?? { id: SessionId(input.sessionId), header: stored.meta, events: stored.events };
      let selection;
      for (let i = stored.events.length - 1; i >= 0; i--) {
        const event = stored.events[i];
        if (event.type === "request/header") { selection = event.data?.config; break; }
      }
      // Same native cut as permissions/selection; no second history read or Agent activation.
      const nextSeq = (stored.events.at(-1)?.seq ?? -1) + 1;
      return { selection, loaded: live !== undefined,
        historyHead: { sessionId: input.sessionId, nextSeq }, permissions: {
        sandbox: ctx.sandboxPolicy.resolve({ session }),
        approval: ctx.approval.overrideOf(session) ?? ctx.approval.config.policy ?? "ask",
        preset: ctx.permissionPresets.current(stored.events),
        networkPolicy: "not-managed-by-file-sandbox",
      } };
    },
    async resume(input) {
      const overrides = instructionOverrides(input);
      if (resuming.has(input.sessionId)) {
        await resuming.get(input.sessionId);
        return this.resume(input);
      }
      const live = ctx.agents.get(input.sessionId);
      if (live) {
        if (instructions.ensure(live, { ...input, ...overrides })) {
          await ctx.sessions.flush(live.session);
        }
        return { sessionId: input.sessionId };
      }
      const operation = (async () => {
      if (volatileSessions.has(input.sessionId)) throw new Error("Temporary thread has been closed");
      const handle = await ctx.agents.resume({ resumeSessionId: SessionId(input.sessionId),
        agentOptions: { ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) },
        setup: setup(input) });
      handles.set(input.sessionId, handle);
      await ctx.sessions.flush(handle.agent.session);
      return { sessionId: input.sessionId };
      })().finally(() => resuming.delete(input.sessionId));
      resuming.set(input.sessionId, operation);
      return operation;
    },
    async fork(input) {
      const source = ctx.agents.get(input.sourceSessionId)?.session;
      const inspected = source ? { meta: source.header, events: source.events } : await ctx.sessionPersistence.inspect(SessionId(input.sourceSessionId));
      const seed = forkSeed(inspected.events, input, interruptedTurnClosers);
      const instructions = { ...sessionInstructions({ header: inspected.meta, events: seed }), ...instructionOverrides(input) };
      // Policy resolution only reads the event log; constructing a whole throwaway
      // Session here deep-copied and froze the entire seed just to fold it once.
      const permissionState = {
        mode: ctx.sandboxPolicy.resolve({ session: { events: seed, header: inspected.meta, id: SessionId(input.sourceSessionId) } }).mode,
        approval: ctx.approval.overrideOf({ events: seed }) ?? ctx.approval.config.policy ?? "ask",
      };
      return create({ ...input, ...instructions, seed, cwd: input.cwd ?? inspected.meta.cwd,
        agentPreset: input.agentPreset ?? inspected.meta.agentPreset, permissionState: input.permissionState ?? permissionState,
        permissionPreset: input.permissionPreset ?? ctx.permissionPresets.current(seed) });
    },
    async inject(input) {
      const agent = ctx.agents.get(input.sessionId);
      if (!agent || agent.status !== "idle") throw new Error("History injection requires an idle loaded thread");
      const messages = input.items.map(item => {
        if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)
          || item.content.some(block => block.type !== "input_text" || typeof block.text !== "string")) throw new Error("Unsupported history item");
        return createUserMessage({ content: item.content.map(block => ({ type: "text", text: block.text })), source: { kind: "plugin", plugin: "opencraft:history-boundary" } });
      });
      for (const message of messages) agent.session.append("user/message", message, { surfaceOp: "append" });
      await ctx.sessions.flush(agent.session);
      return {};
    },
    async release(input) {
      const handle = handles.get(input.sessionId);
      if (!handle) return { released: !ctx.agents.get(input.sessionId) };
      if (ctx.goals.get(handle.agent)?.activation === "armed") throw new Error("Cannot unload a thread with an armed goal");
      if (ctx.jobs?.list(handle.agent).some(job => job.ownerSession === handle.agent.id && ["running", "stopping"].includes(job.status))) throw new Error("Cannot unload a thread with active background jobs");
      if (handle.agent.status !== "idle") throw new Error("Cannot unload a thread with active execution");
      await handle.dispose(); handles.delete(input.sessionId);
      volatileSessions.forget(input.sessionId);
      return { released: true };
    },
  };
}
