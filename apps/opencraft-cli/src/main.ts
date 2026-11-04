#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { threadCli } from '@opencraft/session-capabilities/thread-cli';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CollaborationClient } from '@opencraft/appserver-client/collaboration';
import { parseConversationRef, conversationLink, type ConversationRef, type ConversationMetadata } from '@opencraft/appserver-protocol/collaboration';
import { CliSshTransport } from './ssh';
import { CliError, classify } from './errors';
import { prepareSend, sendMessage, type SendInput } from './send';
export { CliError, classify } from './errors';

interface Profile { sshAlias: string; instanceId: string; defaultServer?: string; sshConfig?: string; webUrl?: string }
interface Connections { schemaVersion: 1; defaultConnection?: string; connections: Record<string, Profile> }
const help = `Usage: opencraft <command> [options]
For Agent parent/child orchestration, call thread_cli in your execution.
Its private launcher uses this CLI's execution mode (OPENCRAFT_THREAD_CLI_CONNECTION).
  connection add <name> --ssh <alias> [--instance <id>] [--default]
  status
  server list
  thread list [--project <id>] [--cwd <absolute-path>] [--cursor <cursor>] [--include-title]
  thread show <ref-or-link>
  thread log <ref-or-link> [--cursor <cursor>]
  thread send <ref-or-link> [text] [--mode queue] --key <key>
    [--message-file <file|->] [--wait delivered --timeout 30s]
    [--mode steer --expected-turn <exact-turn-id>]
  thread show <ref-or-link> --delivery <request-id>
  thread lookup <ref-or-link> --key <key>
Options: --connection <name> --server <id> --json --help
SSH uses your SSH config, agent/key and known_hosts.
show/list return metadata. log reads one bounded page.
Non-interactive sends need --key. Pipe stdin or pass --message-file -.
Accepted is not completed. After disconnection, use lookup; do not resend.
Attention means open the UI. Configure --web-url during connection add for links.
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
        || typeof profile.instanceId !== 'string' || !profile.instanceId || Object.keys(profile).some(key => !['sshAlias','instanceId','defaultServer','sshConfig','webUrl'].includes(key))
        || profile.sshConfig !== undefined && (typeof profile.sshConfig !== 'string' || !isAbsolute(profile.sshConfig))) throw Error();
      if (profile.webUrl !== undefined) webUrl(profile.webUrl);
    }
    return data;
  } catch { throw new CliError(2, 'INVALID_CONFIG', 'Invalid connections file.'); }
}
function webUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    return url.href;
  } catch { throw new CliError(2, 'INVALID_ARGUMENTS', 'Use a public UI URL without credentials.'); }
}
function withAttentionLink(row: ConversationMetadata, profile: Profile) {
  return row.attention ? { ...row, attention: { ...row.attention, uiLink: profile.webUrl ? conversationLink(profile.webUrl, row.ref) : null } } : row;
}
export async function sendWithAttention(client: CollaborationClient, ref: ConversationRef, input: SendInput,
  scope: Parameters<typeof sendMessage>[3], profile: Profile) {
  if (input.execution?.mode === 'steer') return sendMessage(client, ref, input, scope);
  const receipt = await sendMessage(client, ref, input, scope);
  if (['submitted','injected'].includes(receipt.deliveryState)) return receipt;
  let metadata: ReturnType<typeof withAttentionLink> | undefined;
  try { metadata = withAttentionLink(await client.metadata(ref, 2000), profile); }
  catch { /* Auxiliary metadata is not execution authority or a send prerequisite. */ }
  if (!metadata) return { ...receipt, attention: { kind: 'unknown', interactionId: null,
    uiLink: profile.webUrl ? conversationLink(profile.webUrl, ref) : null, observedAt: null } };
  return metadata.attention ? { ...receipt, attention: { ...metadata.attention, observedAt: metadata.observedAt } } : receipt;
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
export async function run(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, connection: { type: 'string' }, server: { type: 'string' },
      cursor: { type: 'string' }, 'include-title': { type: 'boolean' }, 'metadata-only': { type: 'boolean' },
      ssh: { type: 'string' }, instance: { type: 'string' }, default: { type: 'boolean' }, 'default-server': { type: 'string' },
      'ssh-config': { type: 'string' },
      mode: { type: 'string' }, key: { type: 'string' }, 'message-file': { type: 'string' },
      wait: { type: 'string' }, timeout: { type: 'string' }, delivery: { type: 'string' }, 'delivery-key': { type: 'string' },
      project: { type: 'string' }, cwd: { type: 'string' }, 'expected-turn': { type: 'string' }, 'web-url': { type: 'string' },
    } });
  } catch { throw new CliError(2, 'INVALID_ARGUMENTS', 'Check --help.'); }
  const optionNames = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(optionNames).size !== optionNames.length) throw new CliError(2, 'INVALID_ARGUMENTS', 'Do not repeat options.');
  const options = parsed.values, args = parsed.positionals;
  if (options.help || args.length === 0) return { help };
  const command = args.slice(0, args[0] === 'status' ? 1 : 2).join(' ');
  const counts: Record<string, number> = { status: 1, 'server list': 2, 'connection add': 3, 'thread list': 2, 'thread show': 3, 'thread log': 3,
    'thread send': args.length === 4 ? 4 : 3, 'thread lookup': 3 };
  if (counts[command] !== args.length) throw new CliError(2, 'INVALID_ARGUMENTS', 'Check --help.');
  const allowed = ['json', 'connection', 'server', ...(command === 'connection add' ? ['ssh','ssh-config','instance','default','default-server','web-url'] : []),
    ...(['thread list','thread log'].includes(command) ? ['cursor'] : []), ...(command === 'thread list' ? ['include-title','metadata-only','project','cwd'] : []),
    ...(command === 'thread send' ? ['mode','key','message-file','wait','timeout','expected-turn'] : []),
    ...(command === 'thread lookup' ? ['key'] : []), ...(command === 'thread show' ? ['delivery','delivery-key'] : [])];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new CliError(2, 'INVALID_ARGUMENTS', 'Option is not valid for this command.');
  if (options.delivery !== undefined && options['delivery-key'] !== undefined) throw new CliError(2, 'INVALID_ARGUMENTS', 'Choose --delivery or --delivery-key.');
  if (command === 'thread lookup' && !options.key) throw new CliError(2, 'INVALID_ARGUMENTS', 'Lookup needs --key.');
  if (options.cwd !== undefined && !options.cwd.startsWith('/')) throw new CliError(2, 'INVALID_ARGUMENTS', '--cwd must be absolute on the Server.');
  const sendInput = command === 'thread send' ? await prepareSend(args[3], options['message-file'], options.key, options.mode, options.wait, options.timeout, options['expected-turn']) : null;
  const config = await load();
  let profile: Profile, selected: string, selectionSource: string;
  const adding = args[0] === 'connection' && args[1] === 'add';
  if (adding) {
    selected = args[2] ?? '';
    if (args.length !== 3 || !/^[a-zA-Z0-9][\w.-]{0,63}$/u.test(selected) || !options.ssh) throw new CliError(2, 'INVALID_ARGUMENTS', 'Use connection add <name> --ssh <alias>.');
    if (Object.hasOwn(config.connections, selected)) throw new CliError(5, 'CONNECTION_EXISTS', 'Connection already exists.');
    if (options['ssh-config'] && !isAbsolute(options['ssh-config'])) throw new CliError(2, 'INVALID_ARGUMENTS', 'SSH config path must be absolute.');
    profile = { sshAlias: options.ssh, instanceId: options.instance ?? '',
      ...(options['default-server'] ? { defaultServer: options['default-server'] } : {}), ...(options['ssh-config'] ? { sshConfig: options['ssh-config'] } : {}),
      ...(options['web-url'] ? { webUrl: webUrl(options['web-url']) } : {}) };
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
    if (args[1] === 'list' && args.length === 2) {
      if ((options.project !== undefined || options.cwd !== undefined) && server.capabilities.discoverFilters !== true) throw new CliError(6, 'UNSUPPORTED_CAPABILITY', 'Host lacks discovery filters.');
      const result = await client.discover(server.serverId, options.cursor, options['include-title'], { projectId: options.project, cwd: options.cwd });
      return { ...result, conversations: result.conversations.map(row => withAttentionLink(row, profile)) };
    }
    if (args[1] === 'show' && args.length === 3) {
      if (options.delivery !== undefined) return await client.delivery(uriRef!, options.delivery);
      if (options['delivery-key'] !== undefined) return await client.lookup(uriRef!, options['delivery-key']);
      return withAttentionLink(await client.metadata(uriRef!), profile);
    }
    if (args[1] === 'lookup') return await client.lookup(uriRef!, options.key!);
    if (args[1] === 'send' && sendInput) {
      if (server.capabilities[sendInput.execution?.mode ?? 'queue'] !== true) throw new CliError(6, 'UNSUPPORTED_CAPABILITY', 'Host lacks this input mode.');
      return await sendWithAttention(client, uriRef!, sendInput, { instanceId: directory.instanceId, actorId: directory.actor.id,
        recordsDirectory: join(dirname(configPath()), 'operations') }, profile);
    }
    if (args[1] === 'log' && args.length === 3) {
      if (server.capabilities.boundedRead !== true) throw new CliError(6, 'UNSUPPORTED_CAPABILITY', 'Host lacks bounded history for this engine.');
      return await client.read(uriRef!, options.cursor);
    }
    throw new CliError(2, 'INVALID_ARGUMENTS', 'Check --help.');
  } finally { await client.close(); }
}
export async function main(argv = process.argv.slice(2)) {
  if (process.env.OPENCRAFT_THREAD_CLI_CONNECTION) {
    try { await threadCli(argv); }
    catch { process.stderr.write('Execution CLI failed; inspect state before retrying an uncertain write\n'); process.exitCode=1; }
    return;
  }
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
