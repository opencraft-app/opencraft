#!/usr/bin/env node
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

const stable = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
function version(value) {
  if (typeof value !== 'string' || !stable.test(value)) throw new Error('Release requires a stable X.Y.Z version');
  return value.split('.').map(BigInt);
}
function greater(next, previous) {
  for (let i = 0; i < 3; i++) if (next[i] !== previous[i]) return next[i] > previous[i];
  return false;
}

export function selectRelease({ eventName, ref, event, currentVersion, previousVersion, changelog }) {
  if (ref !== 'refs/heads/main') throw new Error('Release workflow must execute from main');
  if (eventName === 'workflow_dispatch') {
    const tag = event.inputs?.tag;
    if (typeof tag !== 'string' || !tag.startsWith('v')) throw new Error('Missing stable release tag');
    version(tag.slice(1));
    return { publish: true, tag, createTag: false };
  }
  if (eventName !== 'push' || event.deleted) throw new Error('Unsupported release event');
  const next = version(currentVersion), previous = version(previousVersion);
  if (currentVersion === previousVersion) return { publish: false, tag: '', createTag: false };
  if (!greater(next, previous)) throw new Error('Automatic releases must increase the version');
  const tag = `v${currentVersion}`;
  const marker = `## ${tag}\n`;
  const start = changelog.indexOf(marker);
  const end = changelog.indexOf('\n## ', start + marker.length);
  const notes = changelog.slice(start + marker.length, end < 0 ? undefined : end).trim();
  if (!changelog.startsWith('# Changelog\n') || start < 0 || (start > 0 && changelog[start - 1] !== '\n') || !notes) throw new Error('Automatic release requires nonempty committed notes for its exact tag');
  return { publish: true, tag, createTag: true };
}

if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const currentVersion = JSON.parse(readFileSync('packaging/web-server/package.json', 'utf8')).version;
  let previousVersion;
  if (eventName === 'push') {
    if (!/^[a-f0-9]{40}$/u.test(event.before ?? '') || /^0+$/u.test(event.before)) throw new Error('Missing previous main revision');
    previousVersion = JSON.parse(execFileSync('git', ['show', `${event.before}:packaging/web-server/package.json`], { encoding: 'utf8' })).version;
  }
  const request = selectRelease({ eventName, ref: process.env.GITHUB_REF, event, currentVersion, previousVersion, changelog: readFileSync('CHANGELOG.md', 'utf8') });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `publish=${request.publish}\ntag=${request.tag}\ncreate-tag=${request.createTag}\n`);
  console.log(JSON.stringify(request));
}
