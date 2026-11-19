import { createHash } from "node:crypto";
import { sessionError, sessionLink, conversationScopes } from "../remote-browser-state-file.mjs";

const reasons = new Set([
  "conversation-unbound",
  "view-inactive",
  "tab-unavailable",
  "owner-mismatch",
  "hidden",
  "panel-unavailable",
  "paint-timeout",
]);
const terminal = new Set(["visible", "failed", "cancelled", "expired"]);
const fail = (code, message, outcome = "not-dispatched") => Object.assign(sessionError(code, message), { outcome });
function owned(draft, binding, tabId) {
  const state = draft.states.find(([owner]) => owner === binding.ownerId)?.[1];
  const record = draft.pages.find((page) => page.link?.tabId === tabId && page.lifecycle === "open");
  const link = record && sessionLink(state, JSON.parse(record.key)[1]);
  if (
    !link ||
    link.tabId !== tabId ||
    link.hostId !== binding.hostId ||
    !conversationScopes(state, binding.hostId, binding.threadId).has(link.scopeId)
  )
    throw fail("TAB_ACCESS_DENIED", "Browser presentation is outside the admitted conversation");
  return state;
}
function publish(draft, ownerId, previous, requests, receipt) {
  draft.presentationReceipts.put({ ...receipt, ownerId });
  const next = { ...previous, revision: previous.revision + 1, presentationRequests: requests };
  draft.states = draft.states.filter(([owner]) => owner !== ownerId);
  draft.states.push([ownerId, next]);
}
async function update(service, ownerId, id, reduce) {
  let changed = false;
  const value = await service.commit(
    (draft) =>
      reduce(draft, () => {
        changed = true;
      }),
    { ownerId, presentationKeys: [id] },
  );
  if (changed) service.metadataChanged(ownerId);
  return value;
}
async function settle(service, ownerId, id, status) {
  return update(service, ownerId, id, (draft, changed) => {
    const state = draft.states[0]?.[1],
      request = draft.presentationReceipts.get(id);
    if (!request || terminal.has(request.status)) return request;
    const next = { ...request, status };
    publish(
      draft,
      ownerId,
      state,
      (state.presentationRequests ?? []).map((row) => (row.id === id ? next : row)),
      next,
    );
    changed();
    return next;
  });
}
/** Presentation has a separate durable receipt. Native activation and viewer
 * visibility stay with their existing owners; this never invents a viewer. */
export async function presentRemoteTab(service, binding, { tabId }, { signal, timeoutMs = 15000 } = {}) {
  if (
    !binding ||
    typeof binding.authorize !== "function" ||
    ["ownerId", "hostId", "threadId", "turnId", "callId"].some(
      (key) => typeof binding[key] !== "string" || !binding[key] || binding[key].length > 1024,
    ) ||
    typeof tabId !== "string" ||
    !tabId
  )
    throw fail("TAB_ACCESS_DENIED", "Presentation requires admitted execution identity");
  const validate = () => {
    signal?.throwIfAborted();
    binding.authorize();
    if (service.closed) throw fail("BROWSER_UNAVAILABLE", "Browser service closed", "unknown");
  };
  validate();
  await service.load();
  validate();
  const id = createHash("sha256")
    .update(
      JSON.stringify([binding.ownerId, binding.hostId, binding.threadId, binding.turnId, binding.callId, "present"]),
    )
    .digest("hex");
  const receipt = await update(service, binding.ownerId, id, (draft, changed) => {
    validate();
    const state = owned(draft, binding, tabId);
    const previous = state.presentationRequests ?? [],
      existing = draft.presentationReceipts.get(id);
    if (existing) {
      if (existing.tabId !== tabId) throw fail("OPERATION_CONFLICT", "Presentation identity reused for another tab");
      return existing;
    }
    if (!service.presentationAvailable(binding.ownerId))
      throw fail("PRESENTATION_UNAVAILABLE", "No connected workbench can present this browser tab");
    const now = Date.now(),
      pending = previous.filter((row) => !terminal.has(row.status) && row.expiresAt > now);
    if (pending.length >= 8) throw fail("PRESENTATION_BUSY", "Too many pending browser presentations");
    const request = {
      id,
      tabId,
      hostId: binding.hostId,
      threadId: binding.threadId,
      status: "pending",
      createdAt: now,
      expiresAt: now + Math.min(15000, Math.max(1, timeoutMs)),
      ownerId: binding.ownerId,
    };
    publish(
      draft,
      binding.ownerId,
      state,
      [...previous.filter((row) => terminal.has(row.status) || row.expiresAt <= now).slice(-63), ...pending, request],
      request,
    );
    changed();
    return request;
  });
  try {
    for (;;) {
      validate();
      await service.store.tail;
      validate();
      const current =
        service.store.account(binding.ownerId).states[0]?.[1]?.presentationRequests?.find((row) => row.id === id) ??
        (await service.store.readPresentation(binding.ownerId, id)) ??
        receipt;
      validate();
      if (current.status === "visible") return { tabId, visible: true, placement: "right", presentationId: id };
      if (terminal.has(current.status))
        throw fail(
          "PRESENTATION_UNAVAILABLE",
          `Browser presentation ${current.status}${current.reason ? ": " + current.reason : ""}`,
          current.clientId ? "unknown" : "not-dispatched",
        );
      if (Date.now() >= current.expiresAt) {
        await settle(service, binding.ownerId, id, "expired");
        throw fail(
          "PRESENTATION_UNAVAILABLE",
          `No workbench confirmed browser presentation${current.observations?.length ? ": " + current.observations.map((row) => row.reason).join(", ") : ": not observed"}`,
          current.clientId ? "unknown" : "not-dispatched",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) {
    if (signal?.aborted || service.closed) {
      const current = await settle(service, binding.ownerId, id, "cancelled").catch(() => undefined);
      throw Object.assign(new Error(error.message, { cause: error }), {
        code: signal?.aborted ? "BROWSER_ABORTED" : "BROWSER_UNAVAILABLE",
        outcome: current?.clientId ? "unknown" : "not-dispatched",
        retryable: false,
      });
    }
    // Revocation also retires an accepted request; cleanup does not depend on
    // the caller retaining authority and cannot dispatch a presentation again.
    await settle(service, binding.ownerId, id, "cancelled").catch(() => undefined);
    throw error;
  }
}
export async function acknowledgePresentation(service, ownerId, input, authorize) {
  if (
    !input ||
    !/^[0-9a-f]{64}$/.test(input.id ?? "") ||
    !/^[a-zA-Z0-9-]{20,100}$/.test(input.clientId ?? "") ||
    !["claim", "visible", "failed", "observe"].includes(input.action) ||
    (input.reason !== undefined && !reasons.has(input.reason)) ||
    (input.action === "observe" && !reasons.has(input.reason))
  )
    throw fail("INVALID_ARGUMENT", "Invalid browser presentation acknowledgement");
  return update(service, ownerId, input.id, (draft, changed) => {
    authorize();
    if (service.closed) throw fail("BROWSER_UNAVAILABLE", "Browser service closed");
    const state = draft.states[0]?.[1],
      request = draft.presentationReceipts.get(input.id);
    if (!request) throw fail("TAB_ACCESS_DENIED", "Unknown browser presentation");
    if (input.action === "observe") {
      owned(draft, { ownerId, hostId: request.hostId, threadId: request.threadId }, request.tabId);
      if (terminal.has(request.status) || request.observations?.some((row) => row.reason === input.reason))
        return { ...request };
      const next = {
        ...request,
        observations: [...(request.observations ?? []), { reason: input.reason, at: Date.now() }].slice(-7),
      };
      publish(
        draft,
        ownerId,
        state,
        (state.presentationRequests ?? []).map((row) => (row.id === request.id ? next : row)),
        next,
      );
      changed();
      return next;
    }
    if (request.clientId && request.clientId !== input.clientId)
      throw fail("PRESENTATION_CLAIMED", "Another workbench owns this presentation");
    if (terminal.has(request.status)) return { ...request };
    if (request.expiresAt <= Date.now()) throw fail("PRESENTATION_EXPIRED", "Browser presentation expired");
    owned(draft, { ownerId, hostId: request.hostId, threadId: request.threadId }, request.tabId);
    if (input.action !== "claim" && request.status !== "claimed")
      throw fail("PRESENTATION_UNCLAIMED", "Presentation must be claimed before acknowledgement");
    if (input.action === "claim" && request.status === "claimed") return { ...request };
    const next = {
      ...request,
      status: input.action === "claim" ? "claimed" : input.action,
      clientId: input.clientId,
      ...(input.action === "failed" && input.reason ? { reason: input.reason } : {}),
    };
    publish(
      draft,
      ownerId,
      state,
      (state.presentationRequests ?? []).map((row) => (row.id === request.id ? next : row)),
      next,
    );
    changed();
    return next;
  });
}
