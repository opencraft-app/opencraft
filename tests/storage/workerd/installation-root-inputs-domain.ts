// Installation root input ports (gateway-split §4.1.1) inside the
// InstallationCore Durable Object prototype: the document adapter of the root
// input port over the object's own state documents (machine identity, Hub node
// state, configuration values), and identity writes committing on the
// object's own thread through the same-thread commit fence. Shared by
// installation-core-worker.ts (bundled for workerd) and the Node comparison in
// installation-core.scenarios.ts; every method returns JSON-compatible data.
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { MembershipStore } from "@opencraft/access-control";
import { IdentityWriteOwner, IdentityWrites } from "@opencraft/access-control/identity-writes";
import { sameThreadCommitFence } from "@opencraft/access-control/commit-fence";
import { hubId } from "@opencraft/hub-network/store";
import { documentHubStatePort } from "@opencraft/hub-network/state-port-document";
import type { ServerDatabaseHandle } from "@opencraft/storage-node/server-repository";
import type { OwnerCalls } from "@opencraft/worker-owner";
import { documentRootInputs } from "../../../apps/headless-server/src/assembly/root-inputs.ts";

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
async function attempt<T>(action: () => Promise<T> | T): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/** Owner calls on the authorizer's thread, in issue order, each after the previous reply was delivered. */
function sameThreadOwnerCalls(owner: IdentityWriteOwner): OwnerCalls<IdentityWriteOwner> {
  let tail: Promise<unknown> = Promise.resolve();
  return new Proxy({} as OwnerCalls<IdentityWriteOwner>, {
    get:
      (_target, method) =>
      (...args: unknown[]) => {
        const run = tail
          .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
          .then(() => (owner[method as keyof IdentityWriteOwner] as (...values: unknown[]) => unknown)(...args));
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
  });
}

const principal = (subject: string) => ({
  provider: "oidc",
  subject,
  displayName: subject,
  expiresAt: Date.now() + 3_600_000,
});

export class InstallationRootInputsDomain {
  constructor(
    readonly documents: StateDocumentStore,
    readonly handle: ServerDatabaseHandle,
  ) {}

  #inputs(options: { machineName?: string; humanAuthConfiguration?: unknown; hubController?: unknown } = {}) {
    return documentRootInputs({
      documents: this.documents,
      ...(options.humanAuthConfiguration === undefined
        ? {}
        : { humanAuthConfiguration: options.humanAuthConfiguration }),
      ...(options.hubController === undefined ? {} : { hubController: options.hubController }),
      machine: {
        ...(options.machineName === undefined ? {} : { name: options.machineName }),
        defaultName: "installation-core",
        platform: "linux",
      },
    });
  }

  machineIdentity(machineName?: string) {
    return attempt(async () => ({
      ...(await this.#inputs({ ...(machineName === undefined ? {} : { machineName }) }).machineIdentity()),
    }));
  }
  /** Concurrent first reads agree on one ID. */
  machineIdentityTwice() {
    return attempt(async () => {
      const inputs = this.#inputs();
      const [first, second] = await Promise.all([inputs.machineIdentity(), inputs.machineIdentity()]);
      return [first.machineId, second.machineId];
    });
  }
  /** Writes a malformed persisted machine ID, as a corrupted store would hold. */
  corruptMachineIdentity() {
    return attempt(() => this.documents.update("machine-id", () => ({ result: null, next: { machineId: "nope" } })));
  }
  humanAuthConfiguration(input: unknown) {
    return attempt(() => this.#inputs({ humanAuthConfiguration: input }).humanAuthConfiguration());
  }
  relayConnection() {
    return attempt(() => this.#inputs().relayConnection());
  }
  hubController(input: unknown) {
    return attempt(() => this.#inputs({ hubController: input }).hubState.readController());
  }
  /** Opens the Hub node's writer and, with `origin`, saves one published-origin change; closes it again. */
  hubNode(origin?: string) {
    return attempt(async () => {
      const writer = await this.#inputs().hubState.openNode();
      try {
        const state = structuredClone(writer.state);
        if (origin !== undefined) {
          state.origin = origin;
          state.revision++;
          await writer.save(state);
        }
        return { hubId: hubId(state.publicKey), revision: state.revision, origin: state.origin };
      } finally {
        await writer.close();
      }
    });
  }
  /** A save of a state with another Hub identity is refused. */
  hubForeignSave() {
    return attempt(async () => {
      const writer = await this.#inputs().hubState.openNode();
      // Another Hub identity, generated under a separate document key.
      const foreign = await documentHubStatePort(this.documents, { key: "hub-network-other.json" }).openNode();
      try {
        await writer.save({ ...foreign.state, revision: writer.state.revision + 1 });
        return "saved";
      } finally {
        await foreign.close();
        await writer.close();
      }
    });
  }

  /**
   * Identity writes on this thread through the same-thread commit fence:
   * an administrator's write commits; a write authorized by an operator whom
   * an earlier queued write disabled commits nothing.
   */
  async fencedAdministration() {
    const fence = sameThreadCommitFence();
    const owner = new IdentityWriteOwner(this.handle, fence);
    const actors = new ActorStore(this.handle);
    const accounts = new HumanAccounts(this.handle, actors);
    const members = new MembershipStore(this.handle);
    const writes = new IdentityWrites(sameThreadOwnerCalls(owner), actors, accounts, fence, members);
    try {
      const { login: admin } = await writes.issueLogin(principal(`admin-${crypto.randomUUID()}`));
      const { login: operator } = await writes.issueLogin(principal(`operator-${crypto.randomUUID()}`));
      const sessions = () =>
        actors
          .list()
          .filter((actor) => actor.kind === "session")
          .map((actor) => actor.displayName)
          .sort();
      const approved = await writes.createSession(
        () => actors.isCurrent(admin.context),
        "approved",
        admin.context.actorId,
      );
      const disable = writes.setEnabled(
        () => actors.isCurrent(admin.context),
        operator.context.actorId,
        false,
        admin.context.actorId,
      );
      const create = writes.createSession(
        () => actors.isCurrent(operator.context),
        "revoked",
        operator.context.actorId,
      );
      await disable;
      const revoked = await create.then(
        () => "committed",
        (error: Error) => `${error.name}: ${error.message}`,
      );
      return {
        approved: actors.get(approved.id)?.kind ?? null,
        operatorEnabled: actors.get(operator.context.actorId)?.enabled ?? null,
        revoked,
        sessions: sessions(),
      };
    } finally {
      writes.close();
      members.close();
      accounts.close();
      actors.close();
      owner.close();
    }
  }
}

export type InstallationRootInputsMethod = Exclude<keyof InstallationRootInputsDomain, "documents" | "handle">;
