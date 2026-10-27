import assert from "node:assert/strict";
import test from "node:test";
import { FixedHostProfileStore } from "../../apps/workbench-web/src/runtime/fixed-host-profile-store";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";

test("fixed profile observations are Application local; recipe writes never reach a catalog", async () => {
  const profile: HostConnectionProfile = { hostId:"fixture-host",displayName:"Fixture",providerId:"fixture.provider",providerConfig:{instanceId:"ins-fixture",profileId:"sales",accountId:"a",region:"cn"},providerConfigVersion:1,hostKind:"remote-control",enabled:true,autoConnect:false,includeInSidebar:false,credentialRef:null,transportEndpoint:"Fixture",executionLocation:"Fixture",workspaceBrowseRoots:[],revision:0 };
  const input={...profile,providerConfig:{instanceId:"ins-fixture",profileId:"sales",accountId:"a",region:"cn"}};
  const first=new FixedHostProfileStore([input]),second=new FixedHostProfileStore([profile]);
  input.providerConfig.instanceId="caller-changed";
  try {
    assert.deepEqual(first.getSnapshot().profiles[0].providerConfig,profile.providerConfig);
    await assert.rejects(first.put(profile),/embedding product owns Host configuration/);
    await assert.rejects(first.remove(profile.hostId),/embedding product owns Host configuration/);
    const identity={machineId:"12345678-1234-4123-8123-123456789abc",name:"Observed",platform:"linux" as const};
    await first.recordMachineIdentity(profile.hostId,identity,"OpenCraft");
    assert.equal(first.getSnapshot().profiles[0].machineIdentity?.name,"Observed");
    assert.equal(first.getSnapshot().profiles[0].revision,profile.revision);
    assert.equal(second.getSnapshot().profiles[0].machineIdentity,null);
    first.close();const closed=first.getSnapshot();
    await first.recordMachineIdentity(profile.hostId,{...identity,name:"Late"});
    assert.equal(first.getSnapshot(),closed);
  } finally { first.close();second.close(); }
});
