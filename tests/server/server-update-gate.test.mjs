import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function invoke(args, env = process.env) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/gate-server-updates.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    child.once('error', reject); child.once('close', code => accept({ code, output }));
  });
}
test('gate advertises selectable scenarios and refuses an unknown scenario', async () => {
  const help = await invoke(['--help']); assert.equal(help.code, 0); assert.match(help.output, /all\|install\|self-upgrade/);
  const invalid = await invoke(['--scenario', 'unknown']); assert.notEqual(invalid.code, 0);
});
test('missing prerequisites fail with a fresh report and cannot reuse an earlier success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-gate-test-'));
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(root, 'old')); await writeFile(join(root, 'old/report.json'), JSON.stringify({ status: 'passed' }));
    const result = await invoke(['--scenario', 'self-upgrade', '--output', root], { ...process.env, PATH: '/missing-gate-tools' });
    assert.equal(result.code, 1);
    const directories = (await readdir(root)).filter(name => name !== 'old'); assert.equal(directories.length, 1);
    const report = JSON.parse(await readFile(join(root, directories[0], 'report.json'), 'utf8'));
    assert.equal(report.status, 'failed'); assert.equal(report.scenario, 'self-upgrade'); assert.equal(report.model, 'gpt-6-luna');
    assert.ok(report.error); assert.deepEqual(report.proofs, []);
    assert.equal(JSON.parse(await readFile(join(root, 'old/report.json'), 'utf8')).status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const trigger of ['snapshot', 'report']) test(`interrupting the final ${trigger} records interrupted and returns nonzero`, { skip: process.platform !== 'linux' || process.getuid?.() !== 0, timeout: 20_000 }, async () => {
  // Only external commands/stages are fixtures. The real gate handles the signal while awaiting Git.
  const { execFileSync } = await import('node:child_process');
  const { mkdir, writeFile, chmod } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'opencraft-gate-signal-'));
  try {
    const bin = join(root, 'bin'); await mkdir(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const marker = join(root, 'snapshot-count');
    const git = join(bin, 'git');
    await writeFile(git, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);const out=cp.execFileSync(${JSON.stringify(realGit)},args,{encoding:'utf8'});
if(args[0]==='rev-parse'){let count=Number(fs.existsSync(${JSON.stringify(marker)})?fs.readFileSync(${JSON.stringify(marker)},'utf8'):0)+1;fs.writeFileSync(${JSON.stringify(marker)},String(count));
if(count===2 && ${JSON.stringify(trigger)}==='snapshot'){process.kill(process.ppid,'SIGINT');setTimeout(()=>process.stdout.write(out),100);}
else process.stdout.write(out);}else process.stdout.write(out);\n`);
    await chmod(git, 0o755);
    for (const name of ['systemctl', 'codex', 'npm', 'setfacl', 'runuser']) {
      const path = join(bin, name); await writeFile(path, `#!${process.execPath}\nconsole.log('fixture-1');\n`); await chmod(path, 0o755);
    }
    const preload = join(root, 'stage-fixture.cjs');
    await writeFile(preload, `const fs=require('node:fs'),path=require('node:path');
const entry=process.argv[1]||'';
if(entry.endsWith('gate-server-updates.mjs') && ${JSON.stringify(trigger)}==='report') {
 const promises=require('node:fs/promises');const original=promises.writeFile;let sent=false;
 promises.writeFile=async function(file,data,...rest){
  const result=await original.call(this,file,data,...rest);
  if(!sent&&String(file).endsWith('report.json.tmp')&&JSON.parse(String(data)).status==='passed'){
   sent=true;fs.writeFileSync(${JSON.stringify(join(root,'report-interrupted'))},'yes');process.kill(process.pid,'SIGINT');await new Promise(r=>setTimeout(r,100));
  }
  return result;
 };
}
if(!entry.endsWith('gate-server-updates.mjs')&&!entry.startsWith(${JSON.stringify(bin)})){
 const dir=process.env.OPENCRAFT_SERVER_UPDATE_EVIDENCE_DIRECTORY;
 if(dir){fs.writeFileSync(path.join(dir,'self-upgrade-proof.json'),JSON.stringify({model:'gpt-6-luna',sourceSelfUpgrade:true,browserRollback:true,toolCalls:1,shellExecutions:1,before:{pid:1,codexPid:2},after:{pid:1,codexPid:2}}));}
 process.exit(0);
}\n`);
    const output = join(root, 'reports');
    const result = await invoke(['--scenario', 'self-upgrade', '--output', output], { ...process.env,
      PATH: bin + ':' + process.env.PATH, NODE_OPTIONS: `--require=${preload}`, npm_execpath: join(bin, 'npm'), OPENCRAFT_CHROMIUM_EXECUTABLE: process.execPath });
    assert.equal(result.code, 130);
    const runs = await readdir(output); assert.equal(runs.length, 1);
    const report = JSON.parse(await readFile(join(output, runs[0], 'report.json'), 'utf8'));
    assert.equal(report.status, 'interrupted'); assert.match(report.error, /interrupted/);
    assert.equal(Number(await readFile(marker, 'utf8')), 2);
    if (trigger === 'report') assert.equal(await readFile(join(root, 'report-interrupted'), 'utf8'), 'yes');
    assert.ok(report.stages.every(stage => stage.status === 'passed')); // Signal arrived after stages, during final provenance.
  } finally { await rm(root, { recursive: true, force: true }); }
});
