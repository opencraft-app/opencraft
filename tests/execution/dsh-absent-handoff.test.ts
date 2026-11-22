import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startIndependentDshHost } from "../../scripts/server-deployment/dsh-host.mjs";

// Server packages ship the DSH bridge but not the DSH runtime. The independent
// Host must still start and complete a fenced owner handoff, with no native
// writer to inspect, fence or resume.
const expected = (host: any) => ({
  expectedOwner: host.handoff.authority.owner,
  expectedEpoch: host.handoff.authority.snapshot().epoch,
  operationId: "test",
  fence: "test",
});

test(
  "the independent Host hands off its storage without an installed DSH",
  { skip: process.platform !== "linux" ? "Independent Host writer requires Linux flock" : false },
  async (t) => {
    const root = await mkdtemp("/tmp/dsh-absent-");
    const skills = join(root, "skills");
    await mkdir(skills);
    // The packaged layout keeps runtime/dsh for the bridge files, without node_modules.
    await mkdir(join(root, "runtime/dsh"), { recursive: true });
    const options = {
      coldDependencyRoots: [resolve("node_modules")],
      dataDirectory: join(root, "agent"),
      descriptorPath: join(root, "connection.json"),
      runtimeDirectory: root,
      skillsDirectory: skills,
      dshExecutable: join(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
      dshCapabilityPlugin: resolve("apps/local-agent-host/src/dsh-capability-plugin.mjs"),
    };
    const inspected: unknown[][] = [];
    const isolateOs = (host: any) => {
      host.handoff.inspectOsWork = (pids: unknown[]) => {
        inspected.push(pids);
        return { coverage: "complete", activeCount: 0 };
      };
    };
    let host: any;
    t.after(async () => {
      await host?.close();
      await rm(root, { recursive: true, force: true });
    });

    host = await startIndependentDshHost(options);
    isolateOs(host);
    assert.equal(host.engineProcessId, null);
    const occupancy = await host.handoff.inspect();
    assert.deepEqual([occupancy.coverage, occupancy.activeCount], ["complete", 0]);
    assert.deepEqual(inspected.at(-1), [], "no native pid joins the OS-work inspection");

    await host.handoff.control("fence", expected(host));
    await host.handoff.control("release", expected(host));
    await host.close();
    host = await startIndependentDshHost(options);
    isolateOs(host);
    assert.equal(host.handoff.open(), false);
    const ready: any = await host.handoff.control("cold-ready", expected(host));
    await host.handoff.control("resume", { ...expected(host), identity: ready.handoff.ready.identity });
    assert.equal(host.handoff.open(), true);
  },
);
