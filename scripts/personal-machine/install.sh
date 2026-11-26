#!/usr/bin/env bash
set -euo pipefail
umask 077
# The short key retrieves its owner-bound configuration over verified HTTPS.
export OPENCRAFT_MACHINE_KEY="${1:-}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64;;
  Linux-aarch64|Linux-arm64) platform=linux-arm64;;
  Darwin-arm64) platform=darwin-arm64;;
  Darwin-x86_64) platform=darwin-x64;;
  *) echo 'This installer supports Linux and macOS on x64/arm64.' >&2; exit 1;;
esac

node_version=26.7.0
node_compatible() {
  "$1" -e 'const [maj,min]=process.versions.node.split(".").map(Number);process.exit(maj>22||(maj===22&&min>=16)?0:1)' >/dev/null 2>&1
}

node_bin="$(command -v node || true)"
private_node="$HOME/.opencraft/machine-node-$node_version-$platform/bin/node"
if { [ -z "$node_bin" ] || ! node_compatible "$node_bin"; } && [ -x "$private_node" ] && node_compatible "$private_node"; then
  node_bin="$private_node"
fi
if [ -z "$node_bin" ] || ! node_compatible "$node_bin"; then
  runtime="$HOME/.opencraft/machine-node-$node_version-$platform"
  mkdir -p "$runtime"
  archive="node-v$node_version-$platform.tar.gz"
  temp="$(mktemp -d)"
  trap 'rm -rf "$temp"' EXIT
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 180 "https://nodejs.org/dist/v$node_version/$archive" -o "$temp/$archive"
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 180 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$temp/sums"
  (
    cd "$temp"
    if command -v sha256sum >/dev/null; then
      awk -v a="$archive" '$2==a' sums | sha256sum -c - >/dev/null
    else
      awk -v a="$archive" '$2==a' sums | shasum -a 256 -c - >/dev/null
    fi
  )
  tar -xzf "$temp/$archive" --strip-components=1 -C "$runtime"
  rm -rf "$temp"
  trap - EXIT
  node_bin="$runtime/bin/node"
fi
export PATH="$(dirname "$node_bin"):$PATH"

case "${1:-}" in
  --update|--check-update|--rollback|--recover)
    export OPENCRAFT_MACHINE_UPDATE_ACTION="$1" OPENCRAFT_MACHINE_SELECT_ID="${2:-}"
    state="$("$node_bin" --input-type=module - <<'UPDATE'
import { readdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const directory = join(homedir(), ".opencraft/machines");
const matches = [];
for (const id of await readdir(directory)) {
  if (!/^[-a-f0-9]{36}$/u.test(id)) continue;
  const state = join(directory, id);
  const path = join(state, "connection.json");
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error("Connection file must be private to its owner");
  }
  const config = JSON.parse(await readFile(path, "utf8"));
  if (
    config.origin === process.env.OPENCRAFT_MACHINE_ORIGIN
    && config.phase === "enrolled"
    && (!process.env.OPENCRAFT_MACHINE_SELECT_ID || id === process.env.OPENCRAFT_MACHINE_SELECT_ID)
  ) {
    matches.push({ state, config });
  }
}
if (matches.length !== 1) {
  throw new Error("Specify the existing machine ID after the update option when multiple installations exist");
}
const { state, config } = matches[0];
if (!/^[A-Za-z0-9_-]{43}$/u.test(config.credential)) throw new Error("Invalid enrolled machine");
const bytes = await new Promise((done, fail) => {
  const req = (config.origin.startsWith("https:") ? httpsRequest : httpRequest)(
    `${config.origin}/__opencraft_machines/install.sh?module=update&id=${config.id}`,
    { ca: config.ca, headers: { authorization: `Bearer ${config.credential}` }, timeout: 30_000 },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error("Machine updater unavailable"));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 131_072) {
          res.destroy(new Error("Updater too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("end", () => done(Buffer.concat(chunks)));
    },
  );
  req.on("error", fail);
  req.on("timeout", () => req.destroy(new Error("Updater request timed out")));
  req.end();
});
await writeFile(join(state, "update-client.mjs"), bytes, { mode: 0o600 });
process.stdout.write(state);
UPDATE
)"
    unset OPENCRAFT_MACHINE_KEY OPENCRAFT_MACHINE_BOOTSTRAP OPENCRAFT_MACHINE_SELECT_ID
    exec "$node_bin" "$state/update-client.mjs" --state "$state" "$OPENCRAFT_MACHINE_UPDATE_ACTION"
    ;;
esac

if [ -z "${OPENCRAFT_MACHINE_BOOTSTRAP:-}" ]; then
  : "${OPENCRAFT_MACHINE_ORIGIN:?Generate a connection command in OpenCraft first}"
  : "${OPENCRAFT_MACHINE_KEY:?A connection key is required}"
  OPENCRAFT_MACHINE_BOOTSTRAP="$("$node_bin" --input-type=module - <<'BOOTSTRAP'
const origin = process.env.OPENCRAFT_MACHINE_ORIGIN;
const key = process.env.OPENCRAFT_MACHINE_KEY;
if (!/^[A-Za-z0-9_-]{43}$/u.test(key ?? "")) throw new Error("Invalid connection key");
const url = new URL(origin);
if (url.origin !== origin || url.username || url.password || url.protocol !== "https:") {
  throw new Error("Remote enrollment requires an HTTPS connection address");
}
const response = await fetch(`${origin}/__opencraft_machines/bootstrap`, {
  headers: { authorization: `Bearer ${key}` },
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error("Connection key expired or unavailable");
const body = await response.text();
if (body.length > 16_384) throw new Error("Invalid connection configuration");
const config = JSON.parse(body);
if (config.origin !== origin || config.secret !== key) throw new Error("Connection configuration mismatch");
process.stdout.write(JSON.stringify(config));
BOOTSTRAP
)"
  export OPENCRAFT_MACHINE_BOOTSTRAP
fi
unset OPENCRAFT_MACHINE_KEY OPENCRAFT_MACHINE_ORIGIN

# Keep credentials out of argv, npm lifecycle scripts and ordinary terminal logs.
state="$("$node_bin" --input-type=module - <<'JS'
import { get as httpsGet } from "node:https";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

let b;
try {
  b = JSON.parse(process.env.OPENCRAFT_MACHINE_BOOTSTRAP);
} catch {
  throw new Error("Invalid machine command");
}
if (b.schemaVersion !== 1 || !/^[-a-f0-9]{36}$/u.test(b.id) || !/^[a-f0-9]{64}$/u.test(b.digest)) {
  throw new Error("Invalid machine command");
}
const url = new URL(b.origin);
if (
  url.origin !== b.origin
  || url.username
  || url.password
  || url.protocol !== "https:"
  || url.hostname === "localhost"
  || url.hostname.endsWith(".localhost")
  || url.hostname === "[::1]"
  || url.hostname.startsWith("127.")
) {
  throw new Error("Use the Server-provided HTTPS connection command");
}
const state = join(homedir(), ".opencraft", "machines", b.id);
await mkdir(state, { recursive: true, mode: 0o700 });
const configPath = join(state, "connection.json");
let old;
try {
  old = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (old && (old.hubId !== b.hubId || old.id !== b.id || old.origin !== b.origin)) {
  throw new Error("Refusing a different machine identity");
}
if (old?.phase === "enrolled") {
  console.log(state);
  process.exit(0);
}
const sourceUrl = `${b.origin}/__opencraft_machines/source.tgz?id=${b.id}`;
if (b.ca !== undefined && (typeof b.ca !== "string" || b.ca.length > 262_144 || !b.ca.includes("-----BEGIN CERTIFICATE-----"))) {
  throw new Error("Invalid relay certificate");
}
const bytes = b.ca
  ? await new Promise((resolve, reject) => {
      const req = httpsGet(sourceUrl, { ca: b.ca, headers: { authorization: `Bearer ${b.secret}` }, timeout: 120_000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("Pairing expired or unavailable"));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 268_435_456) {
            res.destroy(new Error("Machine archive too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Download timeout")));
    })
  : await (async () => {
      const res = await fetch(sourceUrl, {
        headers: { authorization: `Bearer ${b.secret}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error("Pairing expired or unavailable");
      return Buffer.from(await res.arrayBuffer());
    })();
if (createHash("sha256").update(bytes).digest("hex") !== b.digest) {
  throw new Error("Machine source checksum mismatch");
}
await writeFile(join(state, "source.tgz"), bytes, { mode: 0o600 });
await writeFile(
  `${configPath}.tmp`,
  JSON.stringify({
    ...b,
    credential: old?.credential ?? randomBytes(32).toString("base64url"),
    phase: "pending",
    nativeEnvironment: {
      PATH: process.env.PATH,
      CODEX_HOME: process.env.CODEX_HOME,
      CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME,
      CODEBUDDY_CONFIG_DIR: process.env.CODEBUDDY_CONFIG_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    },
  }),
  { mode: 0o600 },
);
await rename(`${configPath}.tmp`, configPath);
console.log(state);
JS
)"
unset OPENCRAFT_MACHINE_BOOTSTRAP
mkdir -p "$state/runtime"
if [ -f "$state/source.tgz" ]; then
  tar -xzf "$state/source.tgz" -C "$state/runtime"
  "$node_bin" "$state/runtime/scripts/personal-machine/prepare.mjs"
  rm "$state/source.tgz"
  "$node_bin" -e 'const fs=require("node:fs"),p=require("node:path");const s=process.argv[1];fs.writeFileSync(p.join(s,"runtime/.machine-version"),JSON.parse(fs.readFileSync(p.join(s,"connection.json"))).digest+"\n",{mode:0o600});' "$state"
fi
exec "$node_bin" --import "$state/runtime/node_modules/tsx/dist/loader.mjs" "$state/runtime/scripts/personal-machine/daemon.ts" --state "$state" --install
