#!/usr/bin/env bash
set -euo pipefail

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

PNPM_BIN="${LIGHTVELA_DSH_REAL_PNPM_BIN:-}"
if [ -z "${PNPM_BIN}" ]; then
  tooling="${TMPDIR}/tooling"
  npm install --prefix "${tooling}" --no-save --package-lock=false \
    --ignore-scripts --no-audit --no-fund pnpm@10.33.0 >/dev/null
  PNPM_BIN="${tooling}/node_modules/.bin/pnpm"
fi
test "$("${PNPM_BIN}" --version | head -n 1 | tr -d '\r')" = "10.33.0"

plugin="${TMPDIR}/dsh-desktop-pet"
mkdir -p "${plugin}"
git -C "${plugin}" init -q
git -C "${plugin}" config user.name lightvela-test
git -C "${plugin}" config user.email lightvela-test@example.invalid
cat >"${plugin}/package.json" <<'JSON'
{
  "name": "dsh-desktop-pet",
  "version": "0.1.0",
  "scripts": {"prepare": "node prepare.cjs"},
  "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}
}
JSON
cat >"${plugin}/prepare.cjs" <<'JS'
const fs = require('node:fs')
fs.mkdirSync('dist', { recursive: true })
fs.writeFileSync('dist/client.js', 'compiled-by-real-pnpm\n')
JS
printf '%s\n' 'bundle: desktop-pet' >"${plugin}/cordis.patch.yml"
git -C "${plugin}" add package.json prepare.cjs cordis.patch.yml
git -C "${plugin}" commit -qm fixture
revision="$(git -C "${plugin}" rev-parse HEAD)"
dependency="git+file://${plugin}#${revision}"

profile="${TMPDIR}/profile"
mkdir -p "${profile}"
cat >"${profile}/package.json" <<JSON
{
  "name": "dsh-profile-fixture",
  "private": true,
  "dependencies": {"dsh-desktop-pet": "${dependency}"},
  "dsh": {"profile": {"bundles": ["dsh-desktop-pet"]}}
}
JSON
cat >"${profile}/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
dangerouslyAllowAllBuilds: true
YAML
"${PNPM_BIN}" --dir "${profile}" install --prod --fetch-retries 0 >/dev/null
grep -Fq 'compiled-by-real-pnpm' "${profile}/node_modules/dsh-desktop-pet/dist/client.js"

legacy="${TMPDIR}/legacy"
cp -a "${profile}" "${legacy}"
python3 - "${legacy}/package.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    profile = json.load(handle)
profile["pnpm"] = {"onlyBuiltDependencies": ["node-pty"]}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(profile, handle, separators=(",", ":"))
    handle.write("\n")
PY
if "${PNPM_BIN}" --dir "${legacy}" install --lockfile-only --prod --ignore-scripts \
  >"${TMPDIR}/legacy-output" 2>&1; then
  echo 'pnpm 10.33 unexpectedly accepted conflicting build policies' >&2
  exit 1
fi
grep -Fq 'Cannot have both neverBuiltDependencies and onlyBuiltDependencies' \
  "${TMPDIR}/legacy-output"

candidate="${TMPDIR}/candidate"
cp -a "${profile}" "${candidate}"
"${PNPM_BIN}" --dir "${candidate}" install --lockfile-only --prod --ignore-scripts \
  --fetch-retries 0 >/dev/null
"${PNPM_BIN}" --dir "${candidate}" install --frozen-lockfile --prod --ignore-scripts \
  --fetch-retries 0 >/dev/null
grep -Fq 'compiled-by-real-pnpm' "${candidate}/node_modules/dsh-desktop-pet/dist/client.js"
grep -Fq 'bundle: desktop-pet' "${candidate}/node_modules/dsh-desktop-pet/cordis.patch.yml"

echo "deepseek harness real pnpm profile test passed"
