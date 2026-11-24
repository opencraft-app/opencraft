// The production InstallationCore Durable Object (apps/headless-server/src/cloudflare/)
// against the Node Headless server: the same HTTP call sequence (setup, local
// login, sessions, invitations, instance admission, membership revocation,
// logout, restart) runs on both front doors and must give the same results
// after normalizing random IDs, tokens and times. Further scenarios cover
// eviction (the object rebuilt from storage), access watches on the object's
// alarm, and a refused open. Shared by the Miniflare test
// (tests/storage/installation-core-do-workerd.test.ts) and the real-Cloudflare
// rehearsal (`npm run cf:rehearsal`).
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { startHeadlessServer } from "../../../apps/headless-server/src/headless-server.mjs";
import {
  sleep,
  until,
  type WorkerInstance,
  type WorkerRuntime,
  type WorkerScenario,
  type WorkerSpec,
} from "../../cloudflare/worker-runtime.ts";

export const INSTALLATION_CORE_DO_SPEC: WorkerSpec = {
  id: "installation-core-do",
  entry: resolve(import.meta.dirname, "installation-core-do-worker.ts"),
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { INSTALLATION_CORE: "TestInstallationCore" },
  externalNode: true,
};

/** Miniflare origin: Human login accepts plain HTTP only on loopback. */
export const LOCAL_ORIGIN = "http://127.0.0.1:8787";
export const PROOF = "S".repeat(43);
export const OWNER_PASSWORD = "Fixture-owner-password-42";
export const MEMBER_PASSWORD = "Fixture-member-password-42";

/** One installation front door the sequence drives. */
export interface Backend {
  readonly origin: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** A browser: a cookie jar and same-origin JSON writes, as the Web client sends them. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly backend: Backend) {}
  async call(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await this.backend.fetch(path, {
      redirect: "manual",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { origin: this.backend.origin, "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    for (const value of response.headers.getSetCookie()) {
      const [name, token] = value.split(";")[0]!.split("=");
      if (token) this.cookies.set(name!, token);
      else this.cookies.delete(name!);
    }
    return response;
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const COMPARED_HEADERS = ["cache-control", "content-type", "x-content-type-options", "location", "retry-after"];

/**
 * Normalizes one run's observations: IDs become `<id0>`, `<id1>`… in first-seen
 * order, times and secrets become markers, and the origin is replaced. Two
 * runs of the same sequence are then equal exactly when they agree.
 */
export function normalizer(origin: string) {
  const ids = new Map<string, string>();
  const id = (value: string) => {
    if (!ids.has(value)) ids.set(value, `<id${ids.size}>`);
    return ids.get(value)!;
  };
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key === "code" || key === "token") return "<secret>";
      return value.replaceAll(origin, "<origin>").replace(UUID, id);
    }
    if (typeof value === "number" && (value > 1e12 || key === "expiresAt" || key === "createdAt")) return "<time>";
    if (Array.isArray(value)) {
      const items = value.map((item) => walk(item));
      // Membership lists have no defined order (rows keyed by random Actor IDs); compare them as sets.
      return key === "members" || key === "actors"
        ? items.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
        : items;
    }
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
    return value;
  };
  const cookie = (value: string) =>
    value
      .replace(/^([^=]+)=[^;]+/u, (_match, name: string) => `${name}=<token>`)
      .replace(/Max-Age=[1-9]\d*/u, "Max-Age=<positive>")
      // A deployed object is reached over HTTPS, where the login cookie is also Secure.
      .replace(/; Secure/u, "");
  return async (label: string, response: Response) => {
    const type = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const body = type.startsWith("application/json")
      ? walk(JSON.parse(text))
      : type.startsWith("text/html")
        ? "<html>"
        : text;
    return {
      label,
      status: response.status,
      headers: Object.fromEntries(
        COMPARED_HEADERS.flatMap((name) => {
          const value = response.headers.get(name);
          return value === null ? [] : [[name, name === "location" ? value.replaceAll(origin, "<origin>") : value]];
        }),
      ),
      cookies: response.headers.getSetCookie().map(cookie),
      body,
    };
  };
}

/**
 * The call sequence. Returns the normalized observations; `restart` is the
 * front door's own restart (Node: close and start on the same data; the
 * object: a new runtime instance over the same storage).
 */
async function sequence(backend: Backend) {
  const observe = normalizer(backend.origin);
  const seen: Awaited<ReturnType<typeof observe>>[] = [];
  const record = async (label: string, response: Promise<Response>) => {
    const observed = await observe(label, await response);
    seen.push(observed);
    return observed;
  };
  const anonymous = new Browser(backend);
  const owner = new Browser(backend);
  const member = new Browser(backend);
  const memberAgain = new Browser(backend);
  await record("anonymous session", anonymous.call("/__opencraft_access/session"));
  await record("anonymous actor", anonymous.call("/__opencraft_actors/me"));
  await record(
    "anonymous refused page",
    anonymous.call("/__opencraft_access/members", undefined, { accept: "text/html" }),
  );
  await record("setup page", anonymous.call("/setup"));
  await record(
    "setup without proof",
    anonymous.call("/__opencraft_account/setup", {
      proof: "x".repeat(43),
      mode: "web",
      username: "owner",
      password: OWNER_PASSWORD,
    }),
  );
  await record(
    "setup",
    owner.call("/__opencraft_account/setup", {
      proof: PROOF,
      mode: "web",
      username: "owner",
      password: OWNER_PASSWORD,
    }),
  );
  await record("owner account status", owner.call("/__opencraft_account/status"));
  await record("owner session", owner.call("/__opencraft_access/session"));
  await record("owner actor", owner.call("/__opencraft_actors/me"));
  const invitation = await owner.call("/__opencraft_account/invitations", {});
  const { code } = (await invitation.clone().json()) as { code: string };
  seen.push(await observe("invitation", invitation));
  await record(
    "accept invitation",
    member.call("/__opencraft_account/accept", { code, username: "member", password: MEMBER_PASSWORD }),
  );
  await record("member session", member.call("/__opencraft_access/session"));
  const memberActor = await member.call("/__opencraft_actors/me");
  const memberActorId = ((await memberActor.clone().json()) as { actor: { id: string } }).actor.id;
  seen.push(await observe("member actor", memberActor));
  await record("member administers members", member.call("/__opencraft_access/members"));
  await record("owner lists members", owner.call("/__opencraft_access/members"));
  await record(
    "wrong password",
    anonymous.call("/__opencraft_auth/local", { mode: "login", username: "member", password: "wrong-password-42" }),
  );
  await record(
    "unknown user",
    anonymous.call("/__opencraft_auth/local", { mode: "login", username: "nobody", password: MEMBER_PASSWORD }),
  );
  await record(
    "cross-origin login",
    anonymous.call(
      "/__opencraft_auth/local",
      { mode: "login", username: "member", password: MEMBER_PASSWORD },
      { origin: "https://elsewhere.example" },
    ),
  );
  await record(
    "extra login field",
    anonymous.call("/__opencraft_auth/local", {
      mode: "login",
      username: "member",
      password: MEMBER_PASSWORD,
      extra: 1,
    }),
  );
  await record(
    "member second login",
    memberAgain.call("/__opencraft_auth/local", { mode: "login", username: "member", password: MEMBER_PASSWORD }),
  );
  await record("second login session", memberAgain.call("/__opencraft_access/session"));
  await record(
    "session bearer on unscoped route",
    anonymous.call("/__opencraft_access/session", undefined, { authorization: "Bearer oc_actor_fixture" }),
  );
  await record(
    "member cannot change membership",
    member.call("/__opencraft_access/members", { actorId: memberActorId, role: "member", enabled: false }),
  );
  await record(
    "revoke member",
    owner.call("/__opencraft_access/members", { actorId: memberActorId, role: "member", enabled: false }),
  );
  await record("revoked member actor", member.call("/__opencraft_actors/me"));
  await record("revoked member session", member.call("/__opencraft_access/session"));
  await record("revoked second login", memberAgain.call("/__opencraft_access/session"));
  await record(
    "revoked member login",
    anonymous.call("/__opencraft_auth/local", { mode: "login", username: "member", password: MEMBER_PASSWORD }),
  );
  await record("owner members after revocation", owner.call("/__opencraft_access/members"));
  await backend.restart();
  await record("owner actor after restart", owner.call("/__opencraft_actors/me"));
  await record("owner session after restart", owner.call("/__opencraft_access/session"));
  await record("revoked member after restart", member.call("/__opencraft_access/session"));
  await record("setup page after restart", anonymous.call("/setup"));
  await record(
    "setup again",
    anonymous.call("/__opencraft_account/setup", {
      proof: PROOF,
      mode: "web",
      username: "other",
      password: OWNER_PASSWORD,
    }),
  );
  await record("logout", owner.call("/__opencraft_auth/logout", {}));
  await record("logged out actor", owner.call("/__opencraft_actors/me"));
  await record(
    "owner login again",
    owner.call("/__opencraft_auth/local", { mode: "login", username: "owner", password: OWNER_PASSWORD }),
  );
  await record("owner session again", owner.call("/__opencraft_access/session"));
  return seen;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** The Node Headless server from source, with the same Human login configuration and setup proof, listening publicly. */
/** `prepare` runs on the data directory before the server first starts (for example to seed model configuration). */
export async function nodeBackend(
  scratch: string,
  prepare?: (dataDirectory: string) => Promise<void>,
): Promise<Backend> {
  const root = join(scratch, `node-${crypto.randomUUID()}`);
  const webRoot = join(root, "web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>InstallationCore comparison</title>");
  await writeFile(
    join(webRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "installation-core",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const tokenPath = join(root, "setup-token.json");
  const configPath = join(root, "human-auth.json");
  await writeFile(tokenPath, JSON.stringify({ token: PROOF }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ origin, local: true, oidc: [], setupTokenFile: tokenPath }), {
    mode: 0o600,
  });
  const options = {
    root,
    webRoot,
    dataDirectory: join(root, "data"),
    port,
    // A public listener with instance membership: the deployment shape the object serves
    // (a loopback-only gateway adds its own origin check in front of every route).
    host: "0.0.0.0",
    accessControl: true,
    humanAuthConfig: configPath,
    startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", close: async () => {} }),
  };
  await prepare?.(options.dataDirectory);
  let app = await startHeadlessServer(options);
  return {
    origin,
    fetch: (path, init) => fetch(origin + path, init),
    async restart() {
      await app.close();
      app = await startHeadlessServer(options);
    },
    close: () => app.close(),
  };
}

function objectVars(proof: string) {
  return (origin: string) => ({
    OPENCRAFT_HUMAN_AUTH: JSON.stringify({ origin, local: true, oidc: [] }),
    OPENCRAFT_SETUP_TOKEN: proof,
  });
}

/** The InstallationCore object on the runtime, over persisted storage so a restart keeps it. */
async function objectBackend(runtime: WorkerRuntime, proof = PROOF): Promise<Backend & { instance(): WorkerInstance }> {
  const persist = `installation-core-do-${crypto.randomUUID()}`;
  const start = () =>
    runtime.start(INSTALLATION_CORE_DO_SPEC, { persist, vars: objectVars(proof), localOrigin: LOCAL_ORIGIN });
  let instance = await start();
  return {
    get origin() {
      return instance.origin;
    },
    instance: () => instance,
    fetch: (path, init) => instance.fetch(instance.origin + path, init),
    async restart() {
      await runtime.stop(instance);
      instance = await start();
    },
    close: () => runtime.stop(instance),
  };
}

export const evict = async (backend: Backend) => {
  // The aborted request itself fails; the next request constructs the object again.
  await backend.fetch("/__test/evict").catch(() => undefined);
};

export async function login(backend: Backend) {
  const owner = new Browser(backend);
  const setup = await owner.call("/__opencraft_account/setup", {
    proof: PROOF,
    mode: "web",
    username: "owner",
    password: OWNER_PASSWORD,
  });
  assert.equal(setup.status, 200, await setup.clone().text());
  const invitation = (await (await owner.call("/__opencraft_account/invitations", {})).json()) as { code: string };
  const member = new Browser(backend);
  const accepted = await member.call("/__opencraft_account/accept", {
    code: invitation.code,
    username: "member",
    password: MEMBER_PASSWORD,
  });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const memberId = ((await (await member.call("/__opencraft_actors/me")).json()) as { actor: { id: string } }).actor.id;
  return { owner, member, memberId };
}

export const INSTALLATION_CORE_DO_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "the InstallationCore object and the Node Headless server answer one call sequence alike: setup, login, sessions, admission, revocation, restart",
    async run({ runtime, scratch, diagnostic }) {
      const node = await nodeBackend(scratch);
      let nodeRun: Awaited<ReturnType<typeof sequence>>;
      try {
        nodeRun = await sequence(node);
      } finally {
        await node.close();
      }
      const object = await objectBackend(runtime);
      try {
        const objectRun = await sequence(object);
        diagnostic(objectRun.map((step) => `${step.label}: ${step.status}`).join("; "));
        assert.deepEqual(objectRun, nodeRun);
      } finally {
        await object.close();
      }
      // The comparison exercised what it claims: admission, refusal and revocation outcomes.
      const status = (label: string) => nodeRun!.find((step) => step.label === label)?.status;
      assert.deepEqual(
        [
          "owner session",
          "member administers members",
          "revoke member",
          "revoked member session",
          "owner actor after restart",
          "setup again",
          "logged out actor",
        ].map(status),
        [200, 403, 200, 403, 200, 409, 401],
      );
    },
  },
  {
    name: "an evicted InstallationCore object is rebuilt from its storage: logins, membership and setup state survive",
    async run({ runtime }) {
      const object = await objectBackend(runtime);
      try {
        const { owner, member, memberId } = await login(object);
        const before = await (await owner.call("/__opencraft_access/members")).json();
        await evict(object);
        assert.equal((await owner.call("/__opencraft_access/session")).status, 200);
        assert.deepEqual(await (await owner.call("/__opencraft_access/members")).json(), before);
        assert.equal(
          ((await (await member.call("/__opencraft_actors/me")).json()) as { actor: { id: string } }).actor.id,
          memberId,
        );
        assert.equal((await object.fetch("/setup", { redirect: "manual" })).status, 303);
        // A write after eviction commits through the rebuilt owner and survives another eviction.
        assert.equal(
          (await owner.call("/__opencraft_access/members", { actorId: memberId, role: "member", enabled: false }))
            .status,
          200,
        );
        await evict(object);
        assert.equal((await member.call("/__opencraft_access/session")).status, 403);
        assert.equal((await owner.call("/__opencraft_access/session")).status, 200);
      } finally {
        await object.close();
      }
    },
  },
  {
    name: "an InstallationCore access watch rechecks on the object's alarm and revokes a member removed later",
    async run({ runtime }) {
      const object = await objectBackend(runtime);
      try {
        const { owner, member, memberId } = await login(object);
        const watched = (await (await member.call("/__test/watch")).json()) as { alarm: number | null };
        assert.ok(watched.alarm !== null, "the watch armed the object's alarm");
        // Still admitted: the alarm keeps re-arming and nothing is revoked.
        await sleep(1_200 * runtime.patience);
        const admitted = (await (await object.fetch("/__test/watch-state")).json()) as {
          revoked: number | null;
          watching: boolean;
          alarm: number | null;
        };
        assert.equal(admitted.revoked, null);
        assert.equal(admitted.watching, true);
        assert.ok(admitted.alarm !== null);
        const revokedAt = Date.now();
        assert.equal(
          (await owner.call("/__opencraft_access/members", { actorId: memberId, role: "member", enabled: false }))
            .status,
          200,
        );
        const state = await until(
          runtime,
          async () =>
            (await (await object.fetch("/__test/watch-state")).json()) as {
              revoked: number | null;
              watching: boolean;
              alarm: number | null;
            },
          (value) => value.revoked !== null,
          5_000,
          50,
        );
        assert.ok(state.revoked !== null, "the alarm-driven recheck revoked the watch");
        assert.ok(state.revoked >= revokedAt - 1_000);
        assert.equal(state.watching, false);
        assert.equal(state.alarm, null, "a closed watch leaves no alarm armed");
      } finally {
        await object.close();
      }
    },
  },
  {
    name: "an InstallationCore object whose open is refused stays closed, as Node startup fails, and serves nothing",
    async run({ runtime }) {
      // The Node root refuses the same malformed setup proof at startup ("Invalid private setup token file").
      const object = await objectBackend(runtime, "too-short");
      try {
        for (const path of ["/__opencraft_auth/session", "/__opencraft_access/session", "/setup"]) {
          const response = await object.fetch(path);
          assert.equal(response.status, 503, path);
          assert.deepEqual(await response.json(), { error: "installation_unavailable" });
        }
        await object.restart();
        assert.equal((await object.fetch("/__opencraft_access/session")).status, 503);
      } finally {
        await object.close();
      }
    },
  },
];
