import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { SwitchboardStore } from "./store.js";
import { SwitchboardOwner } from "./switchboard-owner.js";

const METHODS = [
  "snapshot",
  "get",
  "message",
  "replyReference",
  "readableMessages",
  "messages",
  "recoverable",
  "peekChallenge",
  "bind",
  "accept",
  "patch",
  "submitted",
  "prepareReply",
  "claimReply",
  "settleReply",
  "interruptUncertain",
  "prune",
  "saveChannel",
  "route",
  "removeChannel",
  "linkSender",
  "unlinkSender",
  "challenge",
  "consumeChallenge",
] as const satisfies readonly (keyof SwitchboardOwner)[];

/** Owns the IM switchboard database off the network thread (`Switchboard.open`). */
serveWorkerOwner(({ path }: { path: string }) => {
  const owner = new SwitchboardOwner(new SwitchboardStore(path));
  return { ready: owner.snapshot(), methods: ownerMethods(owner), close: () => owner.close() };
});

function ownerMethods(owner: SwitchboardOwner) {
  return Object.fromEntries(
    METHODS.map((name) => [name, (owner[name] as (...args: never[]) => unknown).bind(owner)]),
  ) as Record<string, (...args: never[]) => unknown>;
}
