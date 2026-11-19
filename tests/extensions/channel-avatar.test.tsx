import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IdentityAvatarContext } from "@opencraft/extension-react";
import { registerHooks } from "node:module";
const styles = registerHooks({
  load(url, context, next) {
    return /\.(?:css|scss)$/u.test(new URL(url).pathname)
      ? { format: "module", source: "export default {};", shortCircuit: true }
      : next(url, context);
  },
});
const { ChatAvatar, ConversationAvatar } = await import("../../plugins/im/src/channel-chat-ui");
styles.deregister();
(globalThis as { React?: typeof React }).React = React;

test("chat photo resolution only uses the trusted descriptor, never a display label", () => {
  const lookups: string[] = [];
  const provider = {
    id: "test",
    resolve: (kind: string, name: string) => {
      lookups.push(kind + ":" + name);
      return "https://photos.invalid/verified.png";
    },
  };
  const render = (avatar?: { kind: string; name: string }, bot = false) =>
    renderToStaticMarkup(
      <IdentityAvatarContext.Provider value={provider}>
        <ChatAvatar id="opaque-actor" label="spoofed.nickname" avatar={avatar} bot={bot} />
      </IdentityAvatarContext.Provider>,
    );
  assert.ok(!render().includes("<img"));
  assert.deepEqual(lookups, []);
  const html = render({ kind: "employee", name: "verified-account" });
  assert.ok(html.includes("https://photos.invalid/verified.png"));
  assert.deepEqual(lookups, ["employee:verified-account"]);
  render({ kind: "employee", name: "not-used-for-bot" }, true);
  assert.deepEqual(lookups, ["employee:verified-account"]);
});
test("missing provider remains a letter fallback, even for a known identity", () => {
  const html = renderToStaticMarkup(
    <ChatAvatar id="human" label="Alice" avatar={{ kind: "employee", name: "alice" }} />,
  );
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("A"));
});

test("conversation avatar uses the authoritative peer before history and group members rather than the last sender", () => {
  const lookups: string[] = [];
  const provider = {
    id: "test",
    resolve: (kind: string, name: string) => {
      lookups.push(kind + ":" + name);
      return "https://photos.invalid/" + name;
    },
  };
  const actor = {
    actorId: "opaque-person",
    displayName: "Not a login",
    actorKind: "human" as const,
    avatar: { kind: "employee", name: "verified" },
  };
  const render = (group: any, legacyPeer?: any) =>
    renderToStaticMarkup(
      <IdentityAvatarContext.Provider value={provider}>
        <ConversationAvatar group={group} legacyPeer={legacyPeer} />
      </IdentityAvatarContext.Provider>,
    );
  const group = {
    id: "group:one",
    title: "Group not an account",
    kind: "group",
    canSend: true,
    participants: [actor, { actorId: "other", displayName: "Fallback", actorKind: "human" }],
  };
  const html = render(group, { avatar: { kind: "employee", name: "last-sender" } });
  assert.ok(html.includes("im-channel-chat__group-avatar"));
  assert.deepEqual(lookups, ["employee:verified"]);
  lookups.length = 0;
  render({ ...group, kind: "direct", participants: [actor] }, { avatar: { kind: "employee", name: "stale-history" } });
  assert.deepEqual(lookups, ["employee:verified"]);
  lookups.length = 0;
  render({ ...group, kind: "direct", participants: [] }, { avatar: { kind: "employee", name: "stale-history" } });
  assert.deepEqual(lookups, [], "an explicit empty current identity cannot borrow an old photo");
  render({ ...group, participants: undefined });
  assert.deepEqual(lookups, [], "an old server gets the existing fallback, not a title lookup");
});
