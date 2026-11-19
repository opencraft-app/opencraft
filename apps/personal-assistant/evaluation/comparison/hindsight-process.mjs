import { join, resolve } from "node:path";
import { rpc } from "./processes.mjs";

const lab = resolve(import.meta.dirname, "../.."),
  root = resolve(lab, "..");
export function hindsightProcess(directory) {
  return rpc(
    join(root, ".benchmark-tools/hindsight-env/bin/python"),
    [join(import.meta.dirname, "hindsight-worker.py")],
    {
      cwd: lab,
      log: join(directory, "upstream.log"),
      env: {
        HOME: join(directory, "home"),
        LD_PRELOAD: join(root, ".benchmark-tools/nss/lib/usr/lib/x86_64-linux-gnu/libnss_wrapper.so"),
        NSS_WRAPPER_PASSWD: join(root, ".benchmark-tools/nss/passwd"),
        NSS_WRAPPER_GROUP: join(root, ".benchmark-tools/nss/group"),
      },
    },
  );
}

export function presentHindsight(raw) {
  if (!Array.isArray(raw?.results)) throw new Error("Invalid Hindsight recall response");
  return {
    memories: raw.results
      .slice(0, 12)
      .map(({ id, text, fact_type, context, occurred_start, occurred_end, mentioned_at }) => ({
        id,
        text,
        fact_type,
        context,
        occurred_start,
        occurred_end,
        mentioned_at,
      })),
    truncated: raw.results.length > 12,
  };
}
