import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClaudeExecutableError, resolveClaudeCodeExecutable } from '../../apps/claude-code-bridge/src/executable.js';

async function tempRoot(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claude-exec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(file: string, mode = 0o755): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, mode);
}

function resolveIn(root: string, env: Record<string, string | undefined>, platform: NodeJS.Platform = 'linux'): string {
  return resolveClaudeCodeExecutable({
    env,
    home: join(root, 'home'),
    platform,
  });
}

test('CLAUDE_CODE_EXECUTABLE wins when it points at an executable file', async (t) => {
  const root = await tempRoot(t);
  const pinned = join(root, 'pinned');
  const onPath = join(root, 'bin', 'claude');
  await executable(pinned);
  await executable(onPath);
  const resolved = resolveIn(root, {
    CLAUDE_CODE_EXECUTABLE: pinned,
    PATH: join(root, 'bin'),
  });
  assert.equal(resolved, pinned);
});

test('a set CLAUDE_CODE_EXECUTABLE that is not executable is an error', async (t) => {
  const root = await tempRoot(t);
  const onPath = join(root, 'bin', 'claude');
  const plain = join(root, 'not-executable');
  await executable(onPath);
  await executable(plain, 0o644);
  await executable(join(root, 'home', '.local', 'bin', 'claude'));
  for (const pinned of ['', join(root, 'missing'), plain, join(root, 'bin')]) {
    assert.throws(
      () => resolveIn(root, { CLAUDE_CODE_EXECUTABLE: pinned, PATH: join(root, 'bin') }),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeExecutableError);
        assert.match(error.message, /CLAUDE_CODE_EXECUTABLE is set but does not point to an executable file/);
        assert.match(error.message, /Install Claude Code/);
        return true;
      },
    );
  }
});

test('PATH claude is used before common install locations', async (t) => {
  const root = await tempRoot(t);
  const target = join(root, 'real-claude');
  const linked = join(root, 'bin', 'claude');
  const skipped = join(root, 'earlier', 'claude');
  await executable(target);
  await mkdir(dirname(linked), { recursive: true });
  await symlink(target, linked);
  await executable(skipped, 0o644);
  await executable(join(root, 'home', '.local', 'bin', 'claude'));
  const resolved = resolveIn(root, {
    PATH: `${join(root, 'earlier')}:${join(root, 'bin')}`,
  });
  assert.equal(resolved, linked);
});

test('Windows PATH resolves claude.exe and ignores a bare claude name', async (t) => {
  const root = await tempRoot(t);
  const directory = join(root, 'bin');
  await executable(join(directory, 'claude'));
  await executable(join(directory, 'claude.exe'));
  const resolved = resolveIn(root, { PATH: `${join(root, 'empty')};${directory}` }, 'win32');
  assert.equal(resolved, join(directory, 'claude.exe'));

  const prefix = join(root, 'npm-prefix');
  const globalExecutable = join(prefix, 'claude.exe');
  await executable(globalExecutable);
  assert.equal(resolveIn(root, { PATH: '', npm_config_prefix: prefix }, 'win32'), globalExecutable);
});

test('a common install location is used when PATH has no claude', async (t) => {
  const root = await tempRoot(t);
  const older = join(root, 'home', '.claude', 'local', 'claude');
  const native = join(root, 'home', '.local', 'bin', 'claude');
  await executable(older);
  await executable(native);
  assert.equal(resolveIn(root, { PATH: join(root, 'empty') }), older);

  const onlyNative = await tempRoot(t);
  const nativeOnly = join(onlyNative, 'home', '.local', 'bin', 'claude');
  await executable(nativeOnly);
  assert.equal(resolveIn(onlyNative, { PATH: '' }), nativeOnly);

  const fromNpm = await tempRoot(t);
  const prefix = join(fromNpm, 'npm-prefix');
  const globalBin = join(prefix, 'bin', 'claude');
  await executable(globalBin);
  assert.equal(resolveIn(fromNpm, { PATH: '', npm_config_prefix: prefix }), globalBin);
});

test('a missing CLI reports install or CLAUDE_CODE_EXECUTABLE and does not invent a path', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'empty'), { recursive: true });
  assert.throws(
    () => resolveIn(root, { PATH: join(root, 'empty') }),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeExecutableError);
      assert.match(error.message, /Claude Code executable was not found/);
      assert.match(error.message, /Install Claude Code/);
      assert.match(error.message, /CLAUDE_CODE_EXECUTABLE/);
      assert.match(error.message, /bundled binary/);
      return true;
    },
  );
});
