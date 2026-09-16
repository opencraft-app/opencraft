import { randomUUID } from "node:crypto";
import { volatileSessions } from "./dsh-thread-storage.mjs";

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
  const detached = structuredClone(selected);
  return [...detached, ...closers(detached)];
}

/** Native ownership and full event seeding; no renderer projection enters this port. */
export async function createThreadEngine(ctx, toolsModuleUrl) {
  const module = path => new URL(path, toolsModuleUrl).href;
  const { Session, SessionId, interruptedTurnClosers } = await import(module("../../dsh-session/lib/index.js"));
  const { createUserMessage } = await import(module("../../dsh-llm/lib/index.js"));
  const { setSandboxMode } = await import(module("../../dsh-sandbox-policy/lib/index.js"));
  const { setApprovalPolicy } = await import(module("../../dsh-user-approval/lib/index.js"));
  const handles = new Map();
  const setup = input => async child => {
    await ctx.agentPresets.mount(child, input.agentPreset);
    if (input.developerInstructions) child.systemPrompt.section({ name: "opencraft:developer-instructions", order: 90, text: input.developerInstructions });
    if (input.permissionPreset && input.permissionPreset !== "custom") ctx.permissionPresets.set(child.agent.session, input.permissionPreset);
    if (input.permissionState) {
      setSandboxMode(child.agent.session, input.permissionState.mode);
      setApprovalPolicy(child.agent.session, input.permissionState.approval);
    }
  };
  const create = async input => {
    const sessionId = input.sessionId ?? randomUUID();
    if (input.ephemeral) volatileSessions.mark(sessionId);
    const agentPreset = (await ctx.agentPresets.resolve(input.agentPreset)).id;
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId(sessionId),
        seed: input.seed,
        meta: { cwd: input.cwd ?? process.cwd(), agentPreset, ...(input.sourceSessionId ? { parentSession: SessionId(input.sourceSessionId), seedLength: input.seed.length } : {}) },
        agentOptions: { ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) },
        setup: setup({ ...input, agentPreset }) });
      handles.set(sessionId, handle);
      if (handle.agent.session.events.length === 0) handle.agent.session.append("session/end-seed", {});
      await ctx.sessions.flush(handle.agent.session);
      return { sessionId, agentPreset, cwd: handle.agent.session.header.cwd, ephemeral: input.ephemeral === true };
    } catch (error) {
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
    async resume(input) {
      if (ctx.agents.get(input.sessionId)) return { sessionId: input.sessionId };
      if (volatileSessions.has(input.sessionId)) throw new Error("Temporary thread has been closed");
      const agentPreset = (await ctx.agentPresets.resolve(input.agentPreset)).id;
      const handle = await ctx.agents.resume({ resumeSessionId: SessionId(input.sessionId),
        agentOptions: { ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) },
        setup: setup({ ...input, agentPreset }) });
      handles.set(input.sessionId, handle);
      return { sessionId: input.sessionId };
    },
    async fork(input) {
      const source = ctx.agents.get(input.sourceSessionId)?.session;
      const inspected = source ? { meta: source.header, events: source.events } : await ctx.sessionPersistence.inspect(SessionId(input.sourceSessionId));
      const seed = forkSeed(inspected.events, input, interruptedTurnClosers);
      const policySession = Session.create(SessionId(input.sourceSessionId), seed, inspected.meta);
      const permissionState = {
        mode: ctx.sandboxPolicy.resolve({ session: policySession }).mode,
        approval: ctx.approval.overrideOf(policySession) ?? ctx.approval.config.policy ?? "ask",
      };
      return create({ ...input, seed, cwd: input.cwd ?? inspected.meta.cwd,
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
      if (handle.agent.status !== "idle") throw new Error("Cannot unload a thread with active execution");
      await handle.dispose(); handles.delete(input.sessionId);
      volatileSessions.forget(input.sessionId);
      return { released: true };
    },
  };
}
