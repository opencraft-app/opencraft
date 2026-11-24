// InstallationCore stores that used to need a Node owner shell (gateway-split.md
// §4.2 storage row): the Actor/member admission projection, the Server space
// ledger and the orchestration runtime domain (Collaboration, channels,
// inbox, orchestration ledger) over one migrated SqlDatabase. Shared by the
// Durable Object in installation-stores-worker.ts (bundled for workerd) and
// the Node comparison in installation-stores.scenarios.ts, which runs the same
// call sequence on nodeSqlDatabase and compares the normalized results.
import { ActorStore } from "@opencraft/access-control/actors";
import { MembershipStore } from "@opencraft/access-control";
import { serverSpacesDomain } from "@opencraft/access-control/server-spaces-domain";
import { orchestrationRuntimeDomain } from "@opencraft/access-control/orchestration-runtime-domain";
import { WorkspaceActorProjection } from "../../../packages/access-control/src/workspace-actor-projection.ts";
import {
  decodeBase64,
  encodeBase64,
  encodeBase64Url,
  portableSha256Hex,
  sha256Hex,
  utf8ByteLength,
} from "../../../packages/access-control/src/portable-crypto.ts";
import { parsePrincipal } from "@opencraft/identity-core";
import type { ActorContext } from "@opencraft/identity-core/actors";
import type { SqlDatabase } from "@opencraft/sql";
import { migrateServerSqlDatabase } from "@opencraft/storage-node/server-sql";

/** Migrates the Server core composition onto `database` (Node or Durable Object SQL). */
export function migrateInstallation(database: SqlDatabase, ownedByRuntime?: (name: string) => boolean) {
  return migrateServerSqlDatabase(database, ownedByRuntime ? { ownedByRuntime } : {});
}

/** Random ids, tokens and clocks differ per run: replace them by first-seen labels. */
export function normalize(value: unknown, known: Readonly<Record<string, string>> = {}): unknown {
  const labels = new Map<string, string>(Object.entries(known));
  const label = (text: string) => {
    let name = labels.get(text);
    if (!name) labels.set(text, (name = `<id${labels.size}>`));
    return name;
  };
  // Opaque values that embed random ids or tokens as a whole.
  const opaque = new Set(["cursor", "code"]);
  const visit = (item: unknown, key = ""): unknown => {
    if (typeof item === "string")
      return opaque.has(key)
        ? label(item)
        : item.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, label);
    if (typeof item === "number") return item > 1e12 ? "<time>" : item;
    if (Array.isArray(item)) {
      const entries = item.map((entry) => visit(entry));
      // Actors and spaces are listed in id order, and ids are random: order them by content instead.
      return entries.every(
        (entry) => entry && typeof entry === "object" && ("actorId" in entry || "id" in entry || "spaceId" in entry),
      )
        ? entries.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
        : entries;
    }
    if (item instanceof Uint8Array) return { bytes: encodeBase64(item) };
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    return item;
  };
  // As structured data crosses the Durable Object RPC: undefined fields drop out.
  return JSON.parse(JSON.stringify(visit(value)));
}

const settle = async (action: () => Promise<unknown>) => {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const fault = error as Error & { code?: unknown; status?: unknown };
    return { ok: false, error: fault.message, code: fault.code, status: fault.status };
  }
};

/** Digests, encodings and byte lengths the stores rely on, from both SHA-256 paths. */
export function primitives() {
  const text = "opencraft é中😀 \ud800";
  const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 37) % 256);
  return {
    hostDigest: typeof (globalThis as { process?: { getBuiltinModule?: unknown } }).process?.getBuiltinModule,
    sha256: [sha256Hex(""), sha256Hex(text), sha256Hex(bytes)],
    portable: [portableSha256Hex(""), portableSha256Hex(text), portableSha256Hex(bytes)],
    base64: encodeBase64(bytes),
    base64Url: encodeBase64Url(text),
    roundTrip: encodeBase64(decodeBase64(encodeBase64(bytes))) === encodeBase64(bytes),
    lenient: encodeBase64(decodeBase64("AQ*I=junk")),
    length: utf8ByteLength(text),
  };
}

/** One call sequence over the moved stores; returns every result in order. */
export async function installationScenario(database: SqlDatabase, handle: { outcome: unknown }) {
  const source = { database, outcome: handle.outcome } as Parameters<typeof orchestrationRuntimeDomain>[0];
  const steps: [string, unknown][] = [];
  const step = (name: string, value: unknown) => steps.push([name, value]);
  const actors = new ActorStore(source);
  const membership = new MembershipStore(source);
  const expiresAt = Date.now() + 3_600_000;
  const human = (subject: string) =>
    actors.resolveHuman(parsePrincipal({ provider: "local", subject, displayName: subject, expiresAt })!)!;
  const alice = human("alice"),
    bob = human("bob"),
    carol = human("carol");
  membership.set({ provider: "local", subject: "alice" }, "admin", true, "fixture");
  membership.set({ provider: "local", subject: "bob" }, "member", true, "fixture");

  // Session credentials: random token, SHA-256 digest at rest, constant-time comparison.
  const bot = actors.createSession("Bot", alice.actorId);
  const credential = actors.issueCredential(bot.id, expiresAt, alice.actorId);
  const botContext = actors.authenticateSession(credential.token) as ActorContext;
  step("credential token shape", /^[A-Za-z0-9._:-]+$/u.test(credential.token));
  step("session authenticates", botContext?.actorId === bot.id);
  const tampered = credential.token.slice(0, -1) + (credential.token.endsWith("A") ? "B" : "A");
  step("tampered token refused", actors.authenticateSession(tampered) === null);

  // Workspace admission projection (actor-admission-reader's domain).
  const projection = new WorkspaceActorProjection(database);
  const claim = (context: ActorContext) => ({
    actorId: context.actorId,
    generation: context.generation,
    membershipRevision: membership.revocationRevision(context.actorId, [
      {
        provider: "local",
        subject: context.actorId === alice.actorId ? "alice" : context.actorId === bob.actorId ? "bob" : "carol",
      },
    ]),
  });
  const aliceClaim = claim(alice),
    bobClaim = claim(bob),
    carolClaim = claim(carol);
  step("admission alice", [projection.current(aliceClaim), projection.role(alice.actorId)]);
  step("admission bob", [projection.current(bobClaim), projection.role(bob.actorId)]);
  step("admission carol (no membership)", [projection.current(carolClaim), projection.role(carol.actorId)]);
  step(
    "admission wrong generation refused",
    !projection.current({ ...aliceClaim, generation: aliceClaim.generation + 1 }),
  );
  step("admission session actor refused", !projection.current({ ...aliceClaim, actorId: bot.id }));

  // Server spaces (server-spaces worker's domain).
  const spaces = serverSpacesDomain(database, { ownerActorId: alice.actorId, members: [bob.actorId] });
  step("spaces projection", spaces.projection());
  const created = spaces.receive({ method: "command", context: alice, command: { action: "create", name: "Project" } });
  step("space create", created);
  const spaceId = ((created as { result?: { spaceId?: string } }).result?.spaceId ?? "") as string;
  const invite = spaces.receive({ method: "command", context: alice, command: { action: "invite", spaceId } });
  step("space invite", invite);
  const code = (invite as { result?: { code?: string } }).result?.code ?? "";
  step("space join", spaces.receive({ method: "command", context: carol, command: { action: "join", code } }));
  step("space join replay", spaces.receive({ method: "command", context: carol, command: { action: "join", code } }));
  step("space members", spaces.receive({ method: "command", context: alice, command: { action: "members", spaceId } }));
  step("space list carol", spaces.receive({ method: "command", context: carol, command: { action: "list" } }));
  step("space unknown method", spaces.receive({ method: "nope" }));

  // Orchestration runtime domain: Collaboration, channels, attachments and inbox on this connection.
  const runtime = orchestrationRuntimeDomain(source);
  const communicate = (context: ActorContext, method: string, params: Record<string, unknown> = {}) =>
    settle(() => runtime.execute({ method: "communication", payload: { context, method, params } }));
  const group = (await communicate(alice, "opencraft/channels/group/create", {
    title: "Room",
    memberActorIds: [bob.actorId, bot.id],
    clientRequestId: "room",
  })) as { ok: boolean; value?: { result?: { id?: string } } };
  step("group create", group);
  const channelId = group.value?.result?.id ?? "";
  const send = (context: ActorContext, clientMessageId: string, text = clientMessageId) =>
    communicate(context, "opencraft/channels/messages/send", {
      channelId,
      clientMessageId,
      parts: [{ type: "text", text }],
    });
  step("send alice", await send(alice, "hello"));
  step("send replay", await send(alice, "hello"));
  step("send conflict", await send(alice, "hello", "different"));
  step("send bot", await send(botContext, "bot"));
  const file = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7) % 251);
  step(
    "attachment send",
    await communicate(alice, "opencraft/channels/attachments/send", {
      channelId,
      clientMessageId: "file",
      name: "notes.bin",
      type: "application/octet-stream",
      base64: encodeBase64(file),
    }),
  );
  step(
    "attachment non-canonical base64",
    await communicate(alice, "opencraft/channels/attachments/send", {
      channelId,
      clientMessageId: "bad",
      name: "bad.bin",
      type: "application/octet-stream",
      base64: "AQID*",
    }),
  );
  const history = (await communicate(bob, "opencraft/channels/messages/list", { channelId })) as {
    value?: { result?: { messages?: { sequence: number }[] } };
  };
  step("history bob", history);
  const fileSequence = Math.max(0, ...(history.value?.result?.messages ?? []).map((m) => m.sequence));
  const chunk = (await communicate(bob, "opencraft/channels/attachments/read", {
    channelId,
    sequence: fileSequence,
    offset: 65_536,
  })) as { value?: { result?: { base64?: string } } };
  step("attachment chunk", chunk);
  const whole = (await communicate(bob, "opencraft/channels/attachments/get", {
    channelId,
    sequence: fileSequence,
  })) as { value?: { result?: { base64?: string } } };
  step("attachment round trip", whole.value?.result?.base64 === encodeBase64(file));
  step(
    "attachment upload chunk",
    await communicate(alice, "opencraft/channels/attachments/upload", {
      channelId,
      clientMessageId: "upload",
      name: "small.txt",
      type: "text/plain",
      total: 5,
      offset: 0,
      base64: encodeBase64(new TextEncoder().encode("hello")),
    }),
  );
  const inbox = (await communicate(bob, "inbox/sync", {})) as { value?: { result?: { cursor?: string } } };
  step("inbox bob", inbox);
  step("inbox bob again", await communicate(bob, "inbox/sync", { cursor: inbox.value?.result?.cursor }));
  step("inbox forged cursor", await communicate(bob, "inbox/sync", { cursor: encodeBase64Url("{}") }));
  step("channels list carol", await communicate(carol, "opencraft/channels/list"));
  step(
    "orchestration targets",
    await settle(() => runtime.execute({ method: "targets", payload: { includeTerminal: true, now: Date.now() } })),
  );
  step("orchestration pending acks", await settle(() => runtime.execute({ method: "pendingAcks", payload: {} })));
  await runtime.close();
  membership.close();
  actors.close();
  // Name the Actors' random ids so that lists in id order compare by content.
  const uuid = (actorId: string) => actorId.slice(actorId.lastIndexOf("/") + 1);
  return normalize(steps, {
    [alice.actorId.split("/")[2]!]: "<authority>",
    [uuid(alice.actorId)]: "<alice>",
    [uuid(bob.actorId)]: "<bob>",
    [uuid(carol.actorId)]: "<carol>",
    [uuid(bot.id)]: "<bot>",
  });
}
