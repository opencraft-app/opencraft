import { cpSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const previewBranch = process.env.FRONTEND_PREVIEW_BRANCH?.trim();
const previewSha = process.env.FRONTEND_PREVIEW_SHA?.trim();
const region = (process.env.NEXT_PUBLIC_REGION || process.env.VITE_REGION || '').trim();

if (!previewBranch || !previewSha || !region) {
  process.exit(0);
}

const outputByRegion = {
  cn: 'out-cn',
  global: 'out-global',
};

const outputName = outputByRegion[region];
if (!outputName) {
  process.exit(0);
}

const frontendRoot = process.cwd();
const outRoot = join(frontendRoot, 'out');
if (!existsSync(outRoot) || !statSync(outRoot).isDirectory()) {
  throw new Error(`[preserve-next-preview-output] missing Next static output directory: ${outRoot}`);
}

const safeSha = previewSha.replace(/[^a-zA-Z0-9._-]/g, '_');
const backupRoot = join(tmpdir(), 'lightclaw-frontend-preview-output', safeSha);
const backupDir = join(backupRoot, outputName);

rmSync(backupDir, { recursive: true, force: true });
cpSync(outRoot, backupDir, { recursive: true });
console.log(`[preserve-next-preview-output] backed up ${region} output to ${backupDir}`);

if (region === 'global') {
  const cnBackupDir = join(backupRoot, outputByRegion.cn);
  const cnArtifactDir = join(frontendRoot, outputByRegion.cn);
  if (existsSync(cnBackupDir) && !existsSync(cnArtifactDir)) {
    cpSync(cnBackupDir, cnArtifactDir, { recursive: true });
    console.log(`[preserve-next-preview-output] restored cn output to ${cnArtifactDir}`);
  }
}
