#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readPrivateJson } from "../packages/identity-core/src/node.js";
import { MemoryHubStore, parseHubState } from "../packages/hub-network/src/store.js";
import { RelayRedis, readRelayRedisConfiguration } from "../apps/relay-server/src/redis.js";
import { parseRelayConfiguration } from "../apps/relay-server/src/application.js";

const [clusterFile, action, path, expected, ...extra] = process.argv.slice(2);
if (
  !clusterFile ||
  !isAbsolute(clusterFile) ||
  extra.length ||
  !["status", "export", "configure"].includes(action ?? "") ||
  (action === "status" && path) ||
  (action !== "status" && (!path || !isAbsolute(path))) ||
  (action === "export" && expected) ||
  (action === "configure" && !/^[a-f0-9]{64}$/u.test(expected ?? ""))
) {
  throw new Error(
    "Usage: relay-cluster-admin /private/cluster.json status | export /private/new-backup.json | configure /private/new-relay.json EXPECTED_DIGEST",
  );
}
const redis = await RelayRedis.connect(await readRelayRedisConfiguration(clusterFile));
try {
  if (action === "configure") {
    const configuration = parseRelayConfiguration(await readPrivateJson(path!));
    if (!configuration.clusterFile) throw new Error("New configuration must retain Redis cluster mode");
    const digest = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
    const changed = await redis.evaluate(
      `if redis.call('GET',KEYS[1]) then return 0 end
      if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2]); return 1`,
      ["hub-owner", "configuration"],
      [expected!, digest],
    );
    if (changed !== 1)
      throw new Error("Stop all replicas and verify the current configuration digest before changing configuration");
    console.log(JSON.stringify({ configurationDigest: digest }));
  } else {
    const raw = await redis.read("hub-state");
    if (!raw) throw new Error("No shared Hub state");
    const state = parseHubState(JSON.parse(raw));
    if (action === "export") {
      await writeFile(path!, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      console.log(JSON.stringify({ exported: true }));
    } else {
      const store = new MemoryHubStore(state),
        owner = await redis.read("hub-owner");
      console.log(
        JSON.stringify({
          hubId: store.id,
          name: state.name,
          revision: state.revision,
          publicKeySha256: createHash("sha256").update(state.publicKey).digest("hex"),
          owner: owner ? JSON.parse(owner) : null,
          peers: state.peers.length,
          invitations: state.invitations.length,
          configurationDigest: await redis.read("configuration"),
        }),
      );
      store.close();
    }
  }
} finally {
  redis.close();
}
