import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mapPublicWorkspacePaths,
  normalizePathMappings,
  projectPrivateWorkspacePaths,
} from '../../scripts/dsh-subprocess-ssh.mjs'

const mappings = normalizePathMappings([{
  publicPath: '/workspace/.codex',
  privatePath: '/run/hypernode-users/alice-stable/.codex',
}])

test('DSH SSH execution resolves the public CODEX_HOME inside the attached user workspace', () => {
  assert.equal(
    mapPublicWorkspacePaths(
      'head /workspace/.codex/attachments/upload/install.sh',
      mappings,
    ),
    'head /run/hypernode-users/alice-stable/.codex/attachments/upload/install.sh',
  )
})

test('DSH SSH output never exposes the private user-home path', () => {
  assert.equal(
    projectPrivateWorkspacePaths(
      '/run/hypernode-users/alice-stable/.codex/attachments/upload/install.sh',
      mappings,
    ),
    '/workspace/.codex/attachments/upload/install.sh',
  )
})

test('invalid and identity path mappings are ignored', () => {
  assert.deepEqual(normalizePathMappings([
    null,
    { publicPath: 'relative', privatePath: '/private' },
    { publicPath: '/same', privatePath: '/same' },
  ]), [])
})

test('path mappings do not rewrite a merely similar filename', () => {
  assert.equal(
    mapPublicWorkspacePaths('/workspace/.codex-backup/config.toml', mappings),
    '/workspace/.codex-backup/config.toml',
  )
})
