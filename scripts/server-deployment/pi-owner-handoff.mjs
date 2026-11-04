import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AcpHostHandoff } from '../../plugins/acp-engine/src/host-handoff.ts';

/** The persistent owner protocol is shared with ACP. Pi supplies its own
 * native/store authority; it never derives idle from a gateway catalog. */
export class PiOwnerHandoff {
  constructor(directory, runtime, inspectOsWork) {
    this.directory = directory; this.runtime = runtime; this.inspectOsWork = inspectOsWork;
    this.authority = new AcpHostHandoff(join(directory, 'pi'), randomUUID());
    this.operation = Promise.resolve();
  }
  open = () => this.authority.snapshot().phase === 'open' && this.authority.snapshot().persistence === 'ready';
  run = (operation, reconciliation = false) => this.authority.run(operation, reconciliation);
  async load() { await this.authority.load(); }
  attach(pi, host, remotes, remoteInputs) { this.pi = pi; this.host = host; this.remotes = remotes; this.remoteInputs = remoteInputs; }
  async inspect() {
    const pi = await this.pi.handoffObservation();
    const os = this.inspectOsWork(pi.workers);
    const consumer = [...(this.remoteInputs ? [this.remoteInputs.observation()] : []), this.host.consumerObservation(), ...this.remotes.map(remote => remote.handoffObservation())];
    const state = this.authority.snapshot();
    const complete = state.persistence === 'ready' && pi.coverage === 'complete' && os.coverage === 'complete'
      && Number.isSafeInteger(os.activeCount) && os.activeCount >= 0 && consumer.every(row => row.coverage === 'complete');
    return { coverage: complete ? 'complete' : 'unknown', activeCount: complete ? pi.activeCount + os.activeCount + state.activeCalls + consumer.reduce((n, row) => n + row.activeCount, 0) : null,
      pi, os, consumer };
  }
  async coldProof() {
    await this.host.coldReadResources?.();
    const occupancy = await this.inspect();
    if (occupancy.coverage !== 'complete' || occupancy.activeCount !== 0) throw new Error('Pi cold authority incomplete');
    // Include only this owner's roots. Remote providers retain their own stores
    // and writers. No credential bytes or transcript content leave this proof.
    const files = [];
    const visit = async (path, relative, attachments = false) => {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'handoff-cache' || entry.name.endsWith('.lock') || entry.name === 'host-handoff.json') continue;
        const file = join(path, entry.name), name = join(relative, entry.name), stat = await lstat(file);
        if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('Unknown Pi store entry');
        if (stat.isDirectory()) { await visit(file, name, attachments); continue; }
        if (entry.name.endsWith('-shm') || entry.name.endsWith('-wal')) continue;
        const bytes = await readFile(file);
        if (entry.name.endsWith('.json') && (!attachments || entry.name === 'manifest.json')) JSON.parse(bytes.toString());
        // Native SQLite files were decoded in full by handoffObservation.
        if (entry.name.endsWith('.sqlite') && !/^pi_[a-f0-9-]+\.sqlite$/.test(entry.name)
          && !['conversation-schedules.sqlite','interrupted-turn-recovery.sqlite'].includes(entry.name)) throw new Error('Unknown Pi database');
        files.push({ name, digest: createHash('sha256').update(bytes).digest('hex') });
      }
    };
    if (this.runtime.machineId) {
      const machine = (await readFile(join(this.directory,'machine-id'),'utf8')).trim();
      if (machine !== this.runtime.machineId) throw new Error('Pi machine identity changed');
      files.push({name:'machine-id',digest:createHash('sha256').update(machine).digest('hex')});
    }
    await visit(join(this.directory, 'pi'), 'pi');
    await visit(join(this.directory, 'models'), 'models');
    await visit(join(this.directory, 'projects'), 'projects');
    try { await visit(join(this.directory, 'agent', 'attachments'), 'attachments', true); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // These are gateway-owned connection declarations, not Pi's credential
    // authority. Pin their opaque local attachment when one is installed.
    const attachmentPath = join(this.directory, 'session-capabilities.json');
    let attachment;
    try { attachment = await lstat(attachmentPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (attachment) {
      const keyPath = join(this.directory, 'session-capabilities.key'), keyStat = await lstat(keyPath);
      if (![attachment,keyStat].every(info => info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077))) throw new Error('Private capability attachment required');
      const bytes = await readFile(attachmentPath), descriptor = JSON.parse(bytes.toString()), url = new URL(descriptor.url);
      if (descriptor.schemaVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp'
        || url.username || url.password || url.search || url.hash) throw new Error('Invalid capability attachment');
      const key = await readFile(keyPath);
      if (key.length !== 32) throw new Error('Invalid capability attachment key');
      files.push({ name:'capability-attachment', digest:createHash('sha256').update(bytes).update(key).digest('hex') });
    }
    return { runtime: this.runtime, stores: files, history: occupancy.pi.records, capabilities: occupancy.pi.capabilities };
  }
  control(action, input) {
    const operation = this.operation.catch(() => {}).then(async () => {
      if (action === 'fence') await this.authority.fence(input);
      else if (action === 'release') {
        const proof = await this.inspect();
        await this.authority.release(input, () => proof, async () => {
          await this.host.close();
          const os = this.inspectOsWork([]);
          if (os.coverage !== 'complete' || os.activeCount !== 0) throw new Error('Pi OS writer release unconfirmed');
          this.released = true;
        });
      } else if (action === 'cold-ready') await this.authority.coldReady(input, await this.coldProof());
      else if (action === 'resume') {
        await this.authority.resume(input, input.identity ?? '', await this.coldProof());
        await this.pi.resumeBackground();
      } else if (action !== 'inspect') throw new Error('Invalid Pi owner action');
      return { handoff: this.authority.snapshot(), ...(this.released ? { released: true } : { occupancy: await this.inspect() }) };
    });
    this.operation = operation; return operation;
  }
}
