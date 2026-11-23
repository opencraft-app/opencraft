#!/usr/bin/env node
// Offline administration of personal SSH keys. Stop the Headless Server of the
// same data directory first: this tool takes the installation writer lock.
import { isAbsolute } from "node:path";
import { open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { openServerDatabase } from "../../packages/storage-node/src/server/index.js";
import { actorSshKeyMethods } from "../../packages/storage-node/src/server/actor-ssh-keys.js";
import { ActorStore } from "../../packages/access-control/src/actors.js";
import { MembershipStore } from "../../packages/access-control/src/index.js";
import { HumanAccounts } from "../../packages/access-control/src/human-accounts.js";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { createNodePasswordHasher } from "../../plugins/local-account/src/password-hash-node.js";
import { readPrivateJson } from "../../packages/identity-core/src/node.js";
import { ActorSshKeys, ActorSshKeyRefusal, sshKeyOperator } from "../../apps/headless-server/src/actor-ssh-keys.js";
import { importActorSshKeys, parseSshKeyImport } from "../../apps/headless-server/src/actor-ssh-key-import.js";

const usage = `Usage: ssh-keys /absolute/server-data COMMAND
  list    ACTOR                      active keys of a Human
  history ACTOR                      active and revoked keys
  add     ACTOR /absolute/key.pub [NAME]
  remove  ACTOR KEY_ID
  audit   [ACTOR]                    newest 200 changes and refusals
  import  /absolute/private-import.json [--dry-run]
ACTOR: --actor ACTOR_ID | --local USERNAME | --binding PROVIDER SUBJECT`;

const [directory, command, ...rest] = process.argv.slice(2);
if (
  !directory ||
  !isAbsolute(directory) ||
  !["list", "history", "add", "remove", "audit", "import"].includes(command ?? "")
)
  throw new Error(usage);
const info = await stat(directory);
if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
  throw new Error("Server data directory must be owned and private");

const storage = await openServerDatabase(directory);
const actors = new ActorStore(storage);
const members = new MembershipStore(storage);
const accounts = new HumanAccounts(storage, actors);
const localAccounts = new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher());
accounts.registerLocalAccounts(localAccounts);
const methods = actorSshKeyMethods(storage.database);
let keys: ActorSshKeys | undefined;

/** An explicit stable-identity selector; never a display name. */
function selectActor(args: string[]): { actorId: string; rest: string[] } {
  const [kind, value, ...tail] = args;
  if (kind === "--actor" && value) return { actorId: value, rest: tail };
  if (kind === "--local" && value) {
    const identity = localAccounts.identity(value);
    const actor = identity ? actors.findHuman(identity) : null;
    if (!actor) throw new Error("No Human Actor for this local account");
    return { actorId: actor.id, rest: tail };
  }
  if (kind === "--binding" && value && tail[0]) {
    const actor = actors.findHuman({ provider: value, subject: tail[0] });
    if (!actor) throw new Error("No Human Actor for this identity");
    return { actorId: actor.id, rest: tail.slice(1) };
  }
  throw new Error(usage);
}

async function readPublicKey(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Public key path must be absolute");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16384) throw new Error("Public key must be a small regular file");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

const human = (actorId: string) => {
  const actor = actors.get(actorId);
  return actor?.kind === "human" ? actor : null;
};

try {
  keys = await ActorSshKeys.open(
    {
      actorSshKeysSnapshot: async () => methods.actorSshKeysSnapshot(),
      addActorSshKey: async (input) => methods.addActorSshKey(input),
      removeActorSshKey: async (actorId, keyId, operator) => methods.removeActorSshKey(actorId, keyId, operator),
      revokeActorSshKeys: async (actorId, operator, reason) => methods.revokeActorSshKeys(actorId, operator, reason),
    },
    {
      actor: (actorId) => actors.get(actorId),
      // The operator is trusted; the server still requires instance admission at login.
      admits: (actorId) => !(members.actorMembership(actorId)?.enabled === false),
      revoked: (actorId) =>
        members.actorMembership(actorId)?.enabled === false ||
        actors.bindings(actorId).some((binding) => members.membership(binding)?.enabled === false),
      bindings: (actorId) => actors.bindings(actorId),
      administrator: (actorId) => members.actorMembership(actorId)?.role === "admin",
      subscribe: () => () => {},
    },
  );
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === "import") {
    const [path, flag] = rest;
    if (!path || (flag !== undefined && flag !== "--dry-run")) throw new Error(usage);
    const document = parseSshKeyImport(await readPrivateJson(path));
    const results = await importActorSshKeys(keys, document, {
      dryRun: flag === "--dry-run",
      resolveActor: (entry) =>
        entry.actorId !== undefined
          ? (human(entry.actorId)?.id ?? null)
          : (actors.findHuman(entry.binding!)?.id ?? null),
      generation: (actorId) => human(actorId)?.generation ?? null,
    });
    const counts: Record<string, number> = {};
    for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    print({ source: document.source, dryRun: flag === "--dry-run", counts, results });
  } else if (command === "audit") {
    const actorId = rest.length ? selectActor(rest).actorId : null;
    print(methods.actorSshKeyAudit(actorId, 200));
  } else {
    const { actorId, rest: args } = selectActor(rest);
    if (!human(actorId)) throw new Error("Unknown Human Actor");
    if (command === "list") print(keys.list(actorId));
    else if (command === "history")
      print(methods.actorSshKeyHistory(actorId).map(({ publicKey: _omitted, ...row }) => row));
    else if (command === "add") {
      const [path, name] = args;
      if (!path) throw new Error(usage);
      print(await keys.add(actorId, { name, publicKey: await readPublicKey(path) }, sshKeyOperator.local));
    } else {
      const [keyId] = args;
      if (!keyId) throw new Error(usage);
      await keys.remove(actorId, keyId, sshKeyOperator.local);
      console.log("SSH key revoked.");
    }
  }
} catch (error) {
  if (error instanceof ActorSshKeyRefusal) {
    console.error(`Refused: ${error.code}`);
    process.exitCode = 1;
  } else throw error;
} finally {
  keys?.close();
  accounts.close();
  members.close();
  actors.close();
  await storage.close();
}
