import { resolve, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { service, rpc } from "./processes.mjs";
const lab = resolve(import.meta.dirname, "../.."),
  root = resolve(lab, ".."),
  out = join(lab, "evidence/tencent-comparison-20261109/setup-v4");
await mkdir(out, { recursive: true });
const services = [],
  workers = [];
try {
  const bridge = await service(
    "/opt/opencraft/bin/node",
    [
      join(import.meta.dirname, "bridge.mjs"),
      join(root, ".private/tokenhub-hy4-nothink-codex.json"),
      out,
    ],
    { cwd: lab, log: join(out, "bridge.log") },
  );
  services.push(bridge);
  console.log("bridge", bridge.info);
  const embed = await service(
    join(root, ".benchmark-tools/hy-env/bin/python"),
    [
      join(import.meta.dirname, "embedding-server.py"),
      join(root, ".benchmark-tools/embedding-cache"),
    ],
    {
      cwd: lab,
      log: join(out, "embedding.log"),
      env: { HOME: join(out, "home"), HF_HUB_OFFLINE: "1" },
    },
  );
  services.push(embed);
  console.log("embedding", embed.info);
  for (const name of ["tdb"]) {
    const worker =
      name === "hy"
        ? rpc(
            join(root, ".benchmark-tools/hy-env/bin/python"),
            [join(import.meta.dirname, "hy-worker.py")],
            {
              cwd: lab,
              log: join(out, name + ".log"),
              env: { HOME: join(out, name + "-home") },
            },
          )
        : rpc(
            "/opt/opencraft/bin/node",
            [
              "--import",
              join(
                root,
                "tencentdb-agent-memory/MemoryCore/node_modules/tsx/dist/loader.mjs",
              ),
              join(import.meta.dirname, "tdb-worker.mjs"),
            ],
            {
              cwd: lab,
              log: join(out, name + ".log"),
              env: { HOME: join(out, name + "-home") },
            },
          );
    workers.push(worker);
    console.log(
      name,
      await worker.call({
        op: "init",
        directory: join(out, name + "-data"),
        bridge: "http://127.0.0.1:" + bridge.info.port,
        embedding: "http://127.0.0.1:" + embed.info.port,
        model: bridge.info.model,
      }),
    );
    const record = { name };
    record.add = await worker.call({
      op: "add",
      messages: [
        {
          role: "user",
          content:
            "I prefer jasmine tea, and I do not drink coffee because caffeine keeps me awake.",
        },
        {
          role: "assistant",
          content: "Understood. I will keep that preference in mind.",
        },
      ],
      timestamp: "2026-11-09T00:00:00.000Z",
    });
    if (name === "tdb") record.drain = await worker.call({ op: "drain" });
    record.search = await worker.call({
      op: "search",
      query: "What drink do I prefer?",
    });
    record.snapshot = await worker.call({ op: "snapshot" });
    await writeFile(
      join(out, name + "-probe.json"),
      JSON.stringify(record, null, 2),
    );
    console.log(name, "add/search/snapshot completed");
    await worker.call({ op: "close" });
    await worker.close();
  }
} catch (e) {
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  for (const w of workers) await w.close();
  services.forEach((s) => s.close());
}
