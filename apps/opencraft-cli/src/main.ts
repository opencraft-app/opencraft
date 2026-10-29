#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CollaborationClient, UnsupportedCollaborationCapability } from '@opencraft/appserver-client/collaboration';
import { parseConversationRef, type ConversationRef } from '@opencraft/appserver-protocol/collaboration';
import { CliSshTransport } from './ssh';

export class CliError extends Error {
  constructor(readonly exitCode: number, readonly code: string, message: string, readonly retryable = false, readonly details?: unknown) { super(message); }
}
interface Profile { sshAlias: string; instanceId: string; defaultServer?: string; sshConfig?: string }
interface Connections { schemaVersion: 1; defaultConnection?: string; connections: Record<string, Profile> }
const help = `Usage: opencraft <command> [options]
  connection add <name> --ssh <alias> [--instance <id>] [--default]
  status
  server list
  thread list [--cursor <cursor>] [--include-title]
  thread show <ref-or-link>
  thread log <ref-or-link> [--cursor <cursor>]
Options: --connection <name> --server <id> --json --help
SSH uses your SSH config, agent/key and known_hosts.
show/list return metadata. log reads one bounded page.
`;
const configPath = () => process.env.OPENCRAFT_CONFIG ?? join(homedir(), '.config/opencraft/connections.json');
async function load(): Promise<Connections> {
  let raw: string;
  try { raw = await readFile(configPath(), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, connections: {} }; throw new CliError(2, 'INVALID_CONFIG', 'Cannot read connections.'); }
  try {
    const data = JSON.parse(raw) as Connections;
    if (data.schemaVersion !== 1 || !data.connections || typeof data.connections !== 'object' || Array.isArray(data.connections)) throw Error();
    for (const [name, profile] of Object.entries(data.connections)) {
      if (!/^[a-zA-Z0-9][\w.-]{0,63}$/u.test(name) || !profile || typeof profile.sshAlias !== 'string'
        || typeof profile.instanceId !== 'string' || !profile.instanceId || Object.keys(profile).some(key => !['sshAlias','instanceId','defaultServer','sshConfig'].includes(key))
        || profile.sshConfig !== undefined && (typeof profile.sshConfig !== 'string' || !isAbsolute(profile.sshConfig))) throw Error();
    }
    return data;
  } catch { throw new CliError(2, 'INVALID_CONFIG', 'Invalid connections file.'); }
}
async function save(config: Connections) {
  const path = configPath(), temp = path + '.' + randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
function reference(value: string | undefined, serverId: string | undefined): ConversationRef {
  if (!value) throw new CliError(2, 'INVALID_REFERENCE', 'Give a conversation ref.');
  const ref = parseConversationRef(value);
  if (ref) {
    if (serverId && serverId !== ref.serverId) throw new CliError(5, 'TARGET_CONFLICT', '--server conflicts with the ref.');
    return ref;
  }
  if (/^https?:/u.test(value)) throw new CliError(6, 'UNSUPPORTED_LINK', 'Copy the conversation link from the UI.');
  if (value.includes('://') || !serverId || !value.trim() || /[\s\x00-\x1f]/u.test(value)) throw new CliError(2, 'INVALID_REFERENCE', 'Give a canonical ref or --server.');
  return { serverId, threadId: value };
}
export function classify(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof UnsupportedCollaborationCapability) return new CliError(6, error.code, 'Host lacks ' + error.capability + '.');
  const fault = error as { code?: string; data?: { code?: string; status?: number }; message?: string; cause?: { message?: string } };
  const code = fault.data?.code, status = fault.data?.status;
  if (code === 'unsupported_capability') return new CliError(6, 'UNSUPPORTED_CAPABILITY', 'Host lacks this capability.');
  if (status === 400) return new CliError(2, (code ?? 'invalid_input').toUpperCase(), 'Invalid input.');
  if (status === 401 || status === 403) return new CliError(4, status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN', 'Check your account access.');
  if (status === 404) return new CliError(3, 'UNAVAILABLE', 'Resource unavailable.');
  if (status === 409) return new CliError(5, (code ?? 'conflict').toUpperCase(), code === 'history_changed' ? 'History changed. Start a new page.' : 'State conflict.');
  if (status === 503) return new CliError(8, 'SERVER_UNAVAILABLE', 'Server operation failed.', true);
  if (fault.code === 'TIMEOUT') return new CliError(7, 'TIMEOUT', 'Request timed out.', true);
  if (fault.message === 'SSH access required' || fault.cause?.message === 'SSH access required' || fault.message?.includes('SSH_ACCESS_REQUIRED')) return new CliError(4, 'AUTH_REQUIRED', 'Configure your employee SSH access.');
  return new CliError(7, 'CONNECTION_UNAVAILABLE', 'Connection unavailable.', true);
}
export async function run(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, connection: { type: 'string' }, server: { type: 'string' },
      cursor: { type: 'string' }, 'include-title': { type: 'boolean' }, 'metadata-only': { type: 'boolean' },
      ssh: { type: 'string' }, instance: { type: 'string' }, default: { type: 'boolean' }, 'default-server': { type: 'string' },
      'ssh-config': { type: 'string' },
    } });
  } catch { throw new CliError(2, 'INVALID_ARGUMENTS', 'Check --help.'); }
  const optionNames = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(optionNames).size !== optionNames.length) throw new CliError(2, 'INVALID_ARGUMENTS', 'Do not repeat options.');
  const options = parsed.values, args = parsed.positionals;
  if (options.help || args.length === 0) return { help };
  const command = args.slice(0, args[0] === 'status' ? 1 : 2).join(' ');
  const counts: Record<string, number> = { status: 1, 'server list': 2, 'connection add': 3, 'thread list': 2, 'thread show': 3, 'thread log': 3 };
  if (counts[command] !== args.length) throw new CliError(2, 'INVALID_ARGUMENTS', 'Check --help.');
  const allowed = ['json', 'connection', 'server', ...(command === 'connection add' ? ['ssh','ssh-config','instance','default','default-server'] : []),
    ...(['thread list','thread log'].includes(command) ? ['cursor'] : []), ...(command === 'thread list' ? ['include-title','metadata-only'] : [])];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new CliError(2, 'INVALID_ARGUMENTS', 'Option is not valid for this command.');
  const config = await load();
  let profile: Profile, selected: string, selectionSource: string;
  const adding = args[0] === 'connection' && args[1] === 'add';
  if (adding) {
    selected = args[2] ?? '';
    if (args.length !== 3 || !/^[a-zA-Z0-9][\w.-]{0,63}$/u.test(selected) || !options.ssh) throw new CliError(2, 'INVALID_ARGUMENTS', 'Use connection add <name> --ssh <alias>.');
    if (Object.hasOwn(config.connections, selected)) throw new CliError(5, 'CONNECTION_EXISTS', 'Connection already exists.');
    if (options['ssh-config'] && !isAbsolute(options['ssh-config'])) throw new CliError(2, 'INVALID_ARGUMENTS', 'SSH config path must be absolute.');
    profile = { sshAlias: options.ssh, instanceId: options.instance ?? '',
      ...(options['default-server'] ? { defaultServer: options['default-server'] } : {}), ...(options['ssh-config'] ? { sshConfig: options['ssh-config'] } : {}) };
    selectionSource = 'argument';
  } else {
    selected = options.connection ?? process.env.OPENCRAFT_CONNECTION ?? config.defaultConnection ?? '';
    selectionSource = options.connection ? 'argument' : process.env.OPENCRAFT_CONNECTION ? 'environment' : 'default';
    if (!selected) throw new CliError(Object.keys(config.connections).length ? 5 : 3, 'CONNECTION_REQUIRED', 'Choose --connection.', false, { connections: Object.keys(config.connections) });
    const found = Object.hasOwn(config.connections, selected) ? config.connections[selected] : undefined;
    if (!found) throw new CliError(3, 'UNKNOWN_CONNECTION', 'Connection not registered.');
    profile = found;
  }
  let transport: CliSshTransport;
  try { transport = new CliSshTransport(profile.sshAlias, profile.sshConfig); }
  catch { throw new CliError(2, 'INVALID_ARGUMENTS', 'Invalid SSH alias.'); }
  const client = new CollaborationClient(transport);
  try {
    await client.connect();
    const directory = await client.servers();
    if (profile.instanceId && profile.instanceId !== directory.instanceId) throw new CliError(3, 'INSTANCE_MISMATCH', 'Instance identity changed.');
    if (adding) {
      if (profile.defaultServer && !directory.servers.some(server => server.serverId === profile.defaultServer)) throw new CliError(3, 'UNKNOWN_SERVER', 'Default Server unavailable.');
      config.connections[selected] = { ...profile, instanceId: directory.instanceId };
      if (options.default) config.defaultConnection = selected;
      await save(config);
      return { connection: selected, instanceId: directory.instanceId, actor: directory.actor };
    }
    if (args[0] === 'server' && args[1] === 'list' && args.length === 2) return directory;
    const uriRef = args[0] === 'thread' && args[1] !== 'list' ? reference(args[2], options.server ?? (parseConversationRef(args[2] ?? '') ? undefined : profile.defaultServer)) : null;
    const serverId = options.server ?? uriRef?.serverId ?? profile.defaultServer;
    const candidates = directory.servers.filter(server => !serverId || server.serverId === serverId);
    if (candidates.length === 0) throw new CliError(3, 'UNKNOWN_SERVER', 'Server unavailable.');
    if (candidates.length !== 1) throw new CliError(5, 'AMBIGUOUS_SERVER', 'Choose --server.', false, { servers: candidates.map(server => server.serverId) });
    const server = candidates[0]!;
    if (args[0] === 'status' && args.length === 1) return { connection: selected, selectionSource, instanceId: directory.instanceId,
      actor: directory.actor, server, connectionState: 'ready' };
    if (args[0] !== 'thread') throw new CliError(2, 'INVALID_ARGUMENTS', 'Check --help.');
    if (args[1] === 'list' && args.length === 2) return await client.discover(server.serverId, options.cursor, options['include-title']);
    if (args[1] === 'show' && args.length === 3) return await client.metadata(uriRef!);
    if (args[1] === 'log' && args.length === 3) {
      if (server.capabilities.boundedRead !== true) throw new CliError(6, 'UNSUPPORTED_CAPABILITY', 'Host lacks bounded history for this engine.');
      return await client.read(uriRef!, options.cursor);
    }
    throw new CliError(2, 'INVALID_ARGUMENTS', 'Check --help.');
  } finally { await client.close(); }
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const data = await run(argv);
    if ('help' in data && !argv.includes('--json')) process.stdout.write(data.help as string);
    else process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, data }) + '\n');
  } catch (error) {
    const fault = classify(error);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: fault.code, message: fault.message, retryable: fault.retryable,
      ...(fault.details === undefined ? {} : { details: fault.details }) } }) + '\n');
    process.exitCode = fault.exitCode;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
