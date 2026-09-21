import test from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error Node test runner requires explicit extension here.
const { buildAuthShadowBindingRequest, authShadowBindingPath } = await import("./auth-shadow-binding.ts");

test("authShadowBindingPath encodes the LightVela user id", () => {
  assert.equal(authShadowBindingPath("usr/a b"), "auth/shadow-bindings/usr%2Fa%20b");
});

test("buildAuthShadowBindingRequest trims text and parses positive identifiers", () => {
  assert.deepEqual(buildAuthShadowBindingRequest({
    userId: " usr_1 ",
    shadowUserName: " mock_usr_1 ",
    uin: "450860000013",
    ownerUin: "450860000013",
    appId: "1250000000",
    reason: " personal DevCloud testing ",
  }), {
    userId: "usr_1",
    shadowUserName: "mock_usr_1",
    uin: 450860000013,
    ownerUin: 450860000013,
    appId: 1250000000,
    reason: "personal DevCloud testing",
  });
});

test("buildAuthShadowBindingRequest rejects blank or unsafe fields", () => {
  assert.throws(() => buildAuthShadowBindingRequest({
    userId: "usr_1",
    shadowUserName: "mock_usr_1",
    uin: "0",
    ownerUin: "450860000013",
    appId: "1250000000",
    reason: "testing",
  }), /positive integer/);
  assert.throws(() => buildAuthShadowBindingRequest({
    userId: "usr_1",
    shadowUserName: "mock_usr_1",
    uin: "450860000013",
    ownerUin: "450860000013",
    appId: "1250000000",
    reason: " ",
  }), /reason/);
});
