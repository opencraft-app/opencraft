import assert from "node:assert/strict";
import test from "node:test";
import { stampLogicalClientFrame, routeLogicalClientFrame } from "@opencraft/app-host-protocol";
test("logical frame identity is stamped by Host and replies cannot leak to another client", () => {
  const stamped = stampLogicalClientFrame(JSON.stringify({ id: 1, method: "thread/resume", __opencraftClient: "spoofed" }), "owner");
  assert.equal(JSON.parse(stamped).__opencraftClient, "owner");
  assert.equal(routeLogicalClientFrame(stamped, ["other"]), null);
  assert.equal(JSON.parse(routeLogicalClientFrame(stamped, ["owner"])!).__opencraftClient, undefined);
  assert.equal(routeLogicalClientFrame('{"method":"global"}', ["other"]), '{"method":"global"}');
});
