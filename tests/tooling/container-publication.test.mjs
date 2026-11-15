import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const sha = 'a'.repeat(40), digest = `sha256:${'b'.repeat(64)}`;
const workflow = await readFile(new URL('../../.github/workflows/container.yml', import.meta.url), 'utf8');
test('publication is main-only, dependent on both architectures, with isolated write permissions', () => {
  const [build, distribute, promote] = workflow.split(/\n  (?:distribute|promote):/);
  assert.doesNotMatch(build, /packages: write/);
  assert.match(build, /docker save opencraft:local/);
  assert.doesNotMatch(workflow, /paths:|pull_request_target/);
  for (const section of [distribute, promote]) {
    assert.match(section, /github.repository == 'opencraft-app\/opencraft'/);
    assert.match(section, /github.ref == 'refs\/heads\/main'/);
    assert.match(section, /github.event_name != 'pull_request'/);
    assert.match(section, /packages: write/);
  }
  assert.match(distribute, /needs: docker-compose/);
  assert.match(promote, /needs: distribute/);
  assert.match(promote, /group: container-ghcr-promotion/);
});
async function simulate(t, env = {}, script = 'promote') {
  const dir = await mkdtemp(join(tmpdir(), 'container-publication-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'commands');
  const fake = `#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  'login '*) cat >/dev/null;;
  'push '*) [ "\${FAIL_PUSH:-}" != 1 ];;
  'pull '*) [ "\${FAIL_PULL:-}" != 1 ];;
  *'--format {{.Id}}') echo 'sha256:tested';;
  *'--format {{.Architecture}}') echo amd64;;
  *'org.opencontainers.image.revision'*) echo "$GITHUB_SHA";;
  *'--format {{index .RepoDigests 0}}') echo 'ghcr.io/opencraft-app/opencraft@${digest}';;
  *'--raw') echo '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}';;
  *'imagetools inspect '*':sha-'*)
    case "\${EXISTING:-missing}" in
      missing) echo 'manifest unknown' >&2; exit 1;;
      error) echo 'unauthorized' >&2; exit 1;;
      conflict) echo 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';;
      *) echo '${digest}';;
    esac;;
  *'--format {{.Manifest.Digest}}') echo '${digest}';;
esac
`;
  await writeFile(join(dir, 'docker'), fake, { mode: 0o755 });
  await writeFile(join(dir, 'git'), '#!/bin/sh\nprintf "%s\\trefs/heads/main\\n" "$REMOTE_SHA"\n', { mode: 0o755 });
  const node = process.execPath;
  await writeFile(join(dir, 'node'), `#!/bin/sh\nif [ "$1" = scripts/smoke/server/smoke-container.mjs ]; then echo smoke >> "$COMMAND_LOG"; exit 0; fi\nexec "${node}" "$@"\n`, { mode: 0o755 });
  const result = spawnSync('bash', [resolve(`scripts/ci/${script}-container.sh`)], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
      COMMAND_LOG: log, GH_TOKEN: 'test-only', GITHUB_ACTOR: 'test', GITHUB_SHA: sha,
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      REMOTE_SHA: sha, ARCH: 'amd64', ...env },
  });
  return { ...result, commands: await readFile(log, 'utf8') };
}
test('validated digests become SHA and edge references', async t => {
  const r = await simulate(t); assert.equal(r.status, 0, r.stderr);
  assert.match(r.commands, /create --tag .*:sha-/); assert.match(r.commands, /create --tag .*:edge/);
});
test('old main run cannot move edge backwards', async t => {
  const r = await simulate(t, { REMOTE_SHA: 'c'.repeat(40) }); assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.commands, /create --tag .*:edge/);
});
for (const existing of ['error', 'conflict']) test(`existing SHA ${existing} fails closed`, async t => {
  const r = await simulate(t, { EXISTING: existing }); assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.commands, /create --tag .*:(sha-|edge)/);
});
test('identical SHA rerun does not overwrite the SHA tag', async t => {
  const r = await simulate(t, { EXISTING: 'same' }); assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.commands, /create --tag .*:sha-/);
});
test('distribution logs out before pull and runs digest-pinned smoke', async t => {
  const r = await simulate(t, {}, 'distribute'); assert.equal(r.status, 0, r.stderr);
  assert.ok(r.commands.indexOf('logout') < r.commands.indexOf('pull '));
  assert.match(r.commands, /smoke/);
});
test('private package fails anonymous verification', async t => {
  const r = await simulate(t, { FAIL_PULL: '1' }, 'distribute'); assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.commands, /smoke/);
});
