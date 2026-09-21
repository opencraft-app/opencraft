import assert from "node:assert/strict";
import test from "node:test";

import { embeddedHostProfile } from "../apps/workbench-web/src/embedded-chat/embedded-host-profile";

test("Embedded Workbench owns an explicit non-persistent LightVela Bot binding", () => {
  const profile = embeddedHostProfile({
    accountId: "account-1",
    instanceId: "ins-1",
    profileId: "sales-123",
    region: "intl",
  });

  assert.equal(profile.hostId, "lightvela-embed:ins-1:profile:sales-123");
  assert.equal(profile.providerId, "lightvela.hermes");
  assert.equal(profile.includeInSidebar, false);
  assert.equal(profile.autoConnect, false);
  assert.deepEqual(profile.providerConfig, {
    accountId: "account-1",
    instanceId: "ins-1",
    profileId: "sales-123",
    region: "intl",
  });
});

test("Embedded Workbench rejects ambiguous physical instance identities", () => {
  assert.throws(
    () => embeddedHostProfile({ instanceId: "../other", profileId: "main", region: "cn" }),
    /valid LightVela instance ID/u,
  );
  assert.throws(
    () => embeddedHostProfile({ instanceId: "ins-1", profileId: "\n", region: "cn" }),
    /valid LightVela profile ID/u,
  );
});
