#!/usr/bin/env node
import {publicTextQuery} from '@opencraft/appserver-protocol/collaboration';
import {parseMessageAttachmentQuery} from '@opencraft/appserver-protocol';
import {setThreadDefaults} from './thread-defaults';
import {THREAD_DEFAULTS_SCOPE,parseThreadDefaults,type ThreadDefaultsBundle} from '@opencraft/appserver-protocol/collaboration';
import { recordedNameQuery, unobservedTurnConfiguration } from '@opencraft/appserver-protocol/collaboration';
import { parseArgs } from 'node:util';
import { threadCli } from '@opencraft/session-capabilities/thread-cli';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CollaborationClient } from '@opencraft/appserver-client/collaboration';
import { parseConversationSettings, parseConversationRef, type ConversationRef, type ConversationMetadata } from '@opencraft/appserver-protocol/collaboration';
import { stopThread, cancelQueue } from './control';
import { CliSshTransport } from './ssh';
import { resultTarget, resultTimeout, waitForResult } from './result';
import { CliError, classify } from './errors';
import { help, commandHelp, guide } from './help';
import { cliVersion } from './version';
import { unsupported, acrossServers } from './servers';
import { selectServer } from './servers';
import { conversationUiLink } from './links';
import { createConversation, creationLink } from './create';
import { resolveProject } from './projects';
import { prepareSend, sendMessage, type SendInput } from './send';
export { CliError, classify } from './errors';

interface Profile { sshAlias: string; instanceId: string; defaultServer?: string; sshConfig?: string; webUrl?: string }
interface Connections { schemaVersion: 1; defaultConnection?: string; connections: Record<string, Profile> }
const cliOptions = {
      version: { type: 'boolean', short: 'V' }, output: { type: 'boolean' }, 'all-servers': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, connection: { type: 'string' }, server: { type: 'string' },
      epoch: { type:'string' }, revision: { type:'string' }, submission: { type:'string' }, 'response-file': { type:'string' },
      request: { type: 'string' }, turn: { type: 'string' }, until: { type: 'string' },
      message: {type:'string'}, field: {type:'string'}, limit: { type: 'string' }, 'observe-only': { type: 'boolean' }, cursor: { type: 'string' }, tail: { type: 'string' }, 'include-title': { type: 'boolean' }, 'metadata-only': { type: 'boolean' },
      ssh: { type: 'string' }, instance: { type: 'string' }, default: { type: 'boolean' }, 'default-server': { type: 'string' },
      'ssh-config': { type: 'string' }, model: {type:'string'}, 'reasoning-effort': {type:'string'},
      scope:{type:'string'}, 'collaboration-mode':{type:'string'}, mode: { type: 'string' }, key: { type: 'string' }, 'message-file': { type: 'string' },
      wait: { type: 'string' }, timeout: { type: 'string' }, delivery: { type: 'string' }, 'delivery-key': { type: 'string' }, 'include-turn-configuration': { type: 'boolean' },
      'permission-mode': {type:'string'}, 'service-tier': {type:'string'}, project: { type: 'string' }, cwd: { type: 'string' }, 'expected-turn': { type: 'string' }, 'web-url': { type: 'string' },
    } as const;
// Usage hints share the command lines displayed by --help.
const usageLines = help.split('\n').filter(line => /^  (?:connection|status|server|project|interactions|thread|queue)\b/u.test(line));
const availableCommands = [...new Set(usageLines.map(line => line.trim().split(/\s+/u).slice(0, line.trim().startsWith('status') ? 1 : 2).join(' ')))];
function commandHint(argv: string[]): string {
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (arg.startsWith('-') && arg !== '-') {
      const name = arg.slice(2).split('=')[0]!;
      const definition = Object.hasOwn(cliOptions, name) ? cliOptions[name as keyof typeof cliOptions] : undefined;
      if (definition?.type === 'string' && !arg.includes('=')) index++;
    } else positionals.push(arg);
  }
  return positionals.slice(0, positionals[0] === 'status' ? 1 : 2).join(' ');
}
function argumentDetails(command: string, parameters: string[], reason: string) {
  const usage = usageLines.filter(line => line.trim() === command || line.trim().startsWith(command + ' ')).map(line => 'opencraft ' + line.trim());
  return { command: command || null, parameters, reason, usage: usage.length ? usage : ['opencraft <command> [options]'],
    ...(!availableCommands.includes(command) ? { availableCommands } : {}) };
}
export async function run(argv: string[]) {
  try { return await runCommand(argv); }
  catch (error) {
    if (error instanceof CliError && error.code === 'INVALID_ARGUMENTS' && !(error.details && typeof error.details === 'object' && 'usage' in error.details)) {
      const diagnostic = (error.details ?? {}) as { parameters?: string[]; reason?: string };
      throw new CliError(error.exitCode, error.code, error.message, error.retryable,
        argumentDetails(commandHint(argv), diagnostic.parameters ?? [], diagnostic.reason ?? 'invalid-value'));
    }
    throw error;
  }
}
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
  } catch { throw new CliError(2, 'INVALID_ARGUMENTS', 'Use a public UI URL without credentials.', false, { parameters: ["--web-url"], reason: 'invalid-value' }); }
}
/** Also available to create consumers: a known canonical ref is the only input. */
export { conversationUiLink } from './links';
function withAttentionLink(row: ConversationMetadata, profile: Profile) {
  const uiLink = conversationUiLink(profile.webUrl, row.ref, row.title);
  return { ...row, uiLink, ...(row.attention ? { attention: { ...row.attention, uiLink } } : {}) };
}
export async function sendWithAttention(client: CollaborationClient, ref: ConversationRef, input: SendInput,
  scope: Parameters<typeof sendMessage>[3], profile: Profile) {
  if (input.execution?.mode === 'steer') return { ...await sendMessage(client, ref, input, scope), uiLink: conversationUiLink(profile.webUrl, ref) };
  const receipt = { ...await sendMessage(client, ref, input, scope), uiLink: conversationUiLink(profile.webUrl, ref) };
  if (['submitted','injected'].includes(receipt.deliveryState)) return receipt;
  let metadata: ReturnType<typeof withAttentionLink> | undefined;
  try { metadata = withAttentionLink(await client.metadata(ref, 2000), profile); }
  catch { /* Auxiliary metadata is not execution authority or a send prerequisite. */ }
  if (!metadata) return { ...receipt, attention: { kind: 'unknown', interactionId: null,
    uiLink: receipt.uiLink, observedAt: null } };
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
async function runCommand(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: cliOptions });
  } catch (error) {
    const fault = error as { code?: string; message?: string };
    const parameter = fault.message?.match(/'(-[^' <>]+)/u)?.[1]?.split('=')[0] ?? 'arguments';
    const command = commandHint(argv);
    const reason = fault.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'unknown-option' : 'missing-or-invalid-value';
    const message = reason === 'unknown-option' ? 'Unknown option ' + parameter + '.' : 'Missing or invalid value for ' + parameter + '.';
    throw new CliError(2, 'INVALID_ARGUMENTS', message + (!command ? ' Available commands: ' + availableCommands.join(', ') + '.' : ''), false,
      argumentDetails(command, [parameter], reason));
  }
  const optionNames = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
  const repeated = optionNames.filter((name, index) => optionNames.indexOf(name) !== index);
  if (repeated.length) throw new CliError(2, 'INVALID_ARGUMENTS', 'Do not repeat ' + repeated.map(name => '--' + name).join(', ') + '.', false, argumentDetails(commandHint(argv), repeated.map(name => '--' + name), 'repeated-option'));
  const options = parsed.values, args = parsed.positionals;
  if (options.help) return { help: commandHelp(args) };
  if (options.version) {
    if (args.length || Object.keys(options).some(key => !['version','json'].includes(key))) throw new CliError(2,'INVALID_ARGUMENTS','Use opencraft --version [--json].');
    return cliVersion();
  }
  if (args[0] === 'guide' && args.length === 1 && Object.keys(options).every(key => key === 'json')) return { help: guide };
  if (args.length === 0) return { help: commandHelp([]) };
  const command = args.slice(0, args[0] === 'status' ? 1 : 2).join(' ');
  const counts: Record<string, number> = { 'thread context':3, 'thread commands':3, 'thread attachments':3, 'thread count':2, 'thread search':3, status: 1, 'interactions list':3, 'interactions show':4, 'interactions respond':4, 'thread defaults':3, 'thread stop': 3, 'queue cancel': 3, 'queue list': 3, 'thread wait': 3, 'thread output': 3, 'server list': 2, 'project list': 2, 'server models': 2, 'thread options': 3, 'connection add': 3, 'thread list': 2, 'thread show': 3, 'thread log': 3,
    'thread create': args.length === 3 ? 3 : 2, 'thread send': args.length === 4 ? 4 : 3, 'thread lookup': args.length === 2 ? 2 : 3 };
  if (!Object.hasOwn(counts, command)) throw new CliError(2, 'UNKNOWN_COMMAND', 'Unknown command. Available commands: ' + availableCommands.join(', ') + '.', false, argumentDetails(command, [], 'unknown-command'));
  if (counts[command] !== args.length) {
    const parameter = args.length > counts[command]! ? 'positionals' : command === 'connection add' ? 'name'
      : command === 'thread search' ? 'query' : command === 'interactions show' && args.length === 3 ? 'interaction-id' : 'ref-or-link';
    throw new CliError(2, 'INVALID_ARGUMENTS', (args.length > counts[command]! ? 'Unexpected positional arguments.' : 'Missing ' + parameter + '.'), false,
      argumentDetails(command, [parameter], args.length > counts[command]! ? 'unexpected-positional' : 'missing-positional'));
  }
  const allowed = [...(['thread list','thread search'].includes(command)?['all-servers']:[]),...(command==='thread attachments'?['message','cursor']:[]),...(command==='thread search'?['field','cursor']:[]),...(command === 'queue list' ? ['cursor','limit'] : []),...(command === 'interactions list' ? ['cursor'] : []), ...(command === 'interactions respond' ? ['epoch','revision','submission','response-file'] : []), ...(['thread wait','thread output'].includes(command) ? ['request','key','turn'] : []), ...(command === 'thread wait' ? ['until','timeout','output'] : []), ...(command === 'thread output' ? ['cursor'] : []), 'json', 'connection', 'server', ...(command === 'connection add' ? ['ssh','ssh-config','instance','default','default-server','web-url'] : []),
    ...(['thread list','thread log','project list','server models'].includes(command) ? ['cursor'] : []), ...(command === 'thread log' ? ['tail'] : []), ...(command === 'thread list' ? ['include-title','metadata-only','project','cwd'] : []),
    ...(['thread create','thread send','thread defaults'].includes(command)?['model','reasoning-effort']:[]),
    ...(command === 'thread create' ? ['project','cwd','key','message-file','wait','timeout','permission-mode','service-tier'] : []),
    ...(command === 'thread send' ? ['mode','key','message-file','wait','timeout','expected-turn'] : []),
    ...(command==='thread defaults'?['scope','permission-mode','collaboration-mode','observe-only']:[]),
    ...(command === 'thread stop' ? ['expected-turn','observe-only'] : []), ...(command === 'queue cancel' ? ['request'] : []),
    ...(command === 'thread lookup' ? ['key'] : []), ...(command === 'thread show' ? ['delivery','delivery-key','turn','include-turn-configuration'] : [])];
  const invalidOptions = Object.keys(options).filter(key => !allowed.includes(key));
  if (invalidOptions.length) throw new CliError(2, 'INVALID_ARGUMENTS', invalidOptions.map(key => '--' + key).join(', ') + ' is not valid for ' + command + '.', false, argumentDetails(command, invalidOptions.map(key => '--' + key), 'option-not-allowed'));
  if (options['all-servers'] && (options.server !== undefined || options.cursor !== undefined || options.project !== undefined || options.cwd !== undefined)) throw new CliError(2,'INVALID_ARGUMENTS','--all-servers cannot combine with --server, --cursor, --project or --cwd.',false,{parameters:['--all-servers'],reason:'invalid-combination'});
  if(command==='thread show') {
    const selected=[options.delivery,options['delivery-key'],options.turn].filter(v=>v!==undefined);
    if(selected.length>1||options['include-turn-configuration']&&selected.length!==1||options.turn!==undefined&&!options['include-turn-configuration'])
      throw new CliError(2,'INVALID_ARGUMENTS','Configuration observation needs one --delivery, --delivery-key or --turn.', false, { parameters: ['delivery','delivery-key','turn','include-turn-configuration'].filter(key => options[key as keyof typeof options] !== undefined).map(key => '--' + key), reason: 'invalid-combination' });
    if(options['include-turn-configuration'])resultTarget(options.delivery,options['delivery-key'],options.turn);
  }
  if (options.delivery !== undefined && options['delivery-key'] !== undefined) throw new CliError(2, 'INVALID_ARGUMENTS', 'Choose --delivery or --delivery-key.', false, { parameters: ["--delivery", "--delivery-key"], reason: 'invalid-combination' });
  if(command==='thread attachments'){try{parseMessageAttachmentQuery({...(options.message===undefined?{}:{clientMessageId:options.message}),...(options.cursor===undefined?{}:{cursor:options.cursor})});}catch{throw new CliError(2,'INVALID_ARGUMENTS','Use a bounded client message ID and cursor.', false, { parameters: ["--message", "--cursor"], reason: 'invalid-value' });}}
  if (command === 'thread lookup' && !options.key) throw new CliError(2, 'INVALID_ARGUMENTS', 'Lookup needs --key.', false, { parameters: ["--key"], reason: 'invalid-value' });
  if (options.cwd !== undefined && !options.cwd.startsWith('/')) throw new CliError(2, 'INVALID_ARGUMENTS', '--cwd must be absolute on the Server.', false, { parameters: ["--cwd"], reason: 'invalid-value' });
  if (command === 'thread create' && (!options.project || !options.cwd || !options.key)) throw new CliError(2, 'INVALID_ARGUMENTS', 'Create needs --project, --cwd and --key.', false, { parameters: ['project','cwd','key'].filter(key => !options[key as 'project'|'cwd'|'key']).map(key => '--' + key), reason: 'missing-required-option' });
  if(command==='thread search'){if(!['name','text'].includes(options.field??''))throw new CliError(2,'INVALID_ARGUMENTS','Search needs --field name|text.', false, { parameters: ["--field"], reason: 'invalid-value' });try{(options.field==='text'?publicTextQuery:recordedNameQuery)(args[2]);}catch{throw new CliError(2,'INVALID_ARGUMENTS','Use 1..512 code points; text queries need letters or numbers.', false, { parameters: ["query"], reason: 'invalid-value' });}}
  if (command==='thread stop' && !options['expected-turn']) throw new CliError(2,'INVALID_ARGUMENTS','Stop needs --expected-turn.', false, { parameters: ["--expected-turn"], reason: 'invalid-value' });
  if (options.limit !== undefined && (!/^(?:[1-9][0-9]?|100)$/u.test(options.limit))) throw new CliError(2,'INVALID_ARGUMENTS','Use --limit 1..100.', false, { parameters: ["--limit"], reason: 'invalid-value' });
  if (command==='queue cancel' && !options.request) throw new CliError(2,'INVALID_ARGUMENTS','Cancel needs --request.', false, { parameters: ["--request"], reason: 'invalid-value' });
  if(options['service-tier']!==undefined) throw new CliError(6,'UNSUPPORTED_CAPABILITY','Sticky service tier is not persisted by this Native version.');
  if(options['permission-mode']!==undefined && !['read-only','accept-edits','full'].includes(options['permission-mode'])) throw new CliError(6,'UNSUPPORTED_CAPABILITY','Unsupported named permission mode.');
  let defaultsBundle:ThreadDefaultsBundle|null=null;
  if(command==='thread defaults'){
    if(options['observe-only']){if(['scope','model','reasoning-effort','permission-mode','collaboration-mode'].some(k=>Object.hasOwn(options,k)))throw new CliError(2,'INVALID_ARGUMENTS','Observe-only takes no requested defaults.', false, { parameters: ["--observe-only", "--scope", "--model", "--reasoning-effort", "--permission-mode", "--collaboration-mode"], reason: 'invalid-combination' });}
    else {if(options.scope!==THREAD_DEFAULTS_SCOPE)throw new CliError(2,'INVALID_ARGUMENTS','Defaults require explicit --scope '+THREAD_DEFAULTS_SCOPE+'.', false, { parameters: ['--scope'], reason: 'invalid-value' });
      try{defaultsBundle=parseThreadDefaults({permissionMode:options['permission-mode'],mode:options['collaboration-mode'],model:options.model,reasoningEffort:options['reasoning-effort']});}
      catch{throw new CliError(2,'INVALID_ARGUMENTS','Defaults need named permission, collaboration mode, explicit model and reasoning effort.', false, { parameters: ["--permission-mode", "--collaboration-mode", "--model", "--reasoning-effort"], reason: 'invalid-value' });}}
  }
  const createInput = command === 'thread create' ? await prepareSend(args[2],options['message-file'],options.key,undefined,options.wait,options.timeout) : null;
  if (options.tail !== undefined && (!/^[1-5]$/u.test(options.tail) || options.cursor !== undefined)) throw new CliError(2, 'INVALID_ARGUMENTS', 'Use --tail 1..5 without --cursor.', false, { parameters: ["--tail", "--cursor"], reason: 'invalid-value' });
  const sendInput = command === 'thread send' ? await prepareSend(args[3], options['message-file'], options.key, options.mode, options.wait, options.timeout, options['expected-turn']) : null;
  const target = ['thread wait','thread output'].includes(command) ? resultTarget(options.request,options.key,options.turn) : null;
  if (command === 'thread wait' && options.until !== undefined && options.until !== 'terminal') throw new CliError(2,'INVALID_ARGUMENTS','Use --until terminal.', false, { parameters: ["--until"], reason: 'invalid-value' });
  const waitTimeout = command === 'thread wait' ? resultTimeout(options.timeout) : null;
  if(command!=='thread defaults'&&(options.model!==undefined || options['reasoning-effort']!==undefined)){
    let settings;try{settings=parseConversationSettings({... (options.model===undefined?{}:{model:options.model}),...(options['reasoning-effort']===undefined?{}:{reasoningEffort:options['reasoning-effort']})});}catch{throw new CliError(2,'INVALID_INPUT','Invalid model settings.');}
    const input=createInput??sendInput;if(!input||input.execution?.mode==='steer')throw new CliError(6,'UNSUPPORTED_CAPABILITY','Model settings require Codex queue input.');input.settings=settings;
  }
  let interactionSubmission: import('@opencraft/appserver-protocol').StructuredInteractionSubmission | null = null;
  if (command === 'interactions respond') {
    if (!options.epoch || !options.revision || !/^(0|[1-9][0-9]*)$/u.test(options.revision) || !Number.isSafeInteger(Number(options.revision)) || !options.submission || options.submission.length>128 || !options['response-file']) throw new CliError(2,'INVALID_ARGUMENTS','Respond needs --epoch, --revision, --submission and --response-file.', false, { parameters: ["--epoch", "--revision", "--submission", "--response-file"], reason: 'invalid-value' });
    let response;
    try { const raw=await readFile(options['response-file'],'utf8'); if(raw.length>24000) throw Error(); response=JSON.parse(raw); if(!response || typeof response!=='object' || Array.isArray(response)) throw Error(); }
    catch { throw new CliError(2,'INVALID_ARGUMENTS','Response must be a bounded JSON object file.', false, { parameters: ["--response-file"], reason: 'invalid-value' }); }
    interactionSubmission={interactionId:args[3]!,submissionId:options.submission,expectedEpoch:options.epoch,expectedRevision:Number(options.revision),response};
  }
  const config = await load();
  let profile: Profile, selected: string, selectionSource: string;
  const adding = args[0] === 'connection' && args[1] === 'add';
  if (adding) {
    selected = args[2] ?? '';
    if (args.length !== 3 || !/^[a-zA-Z0-9][\w.-]{0,63}$/u.test(selected) || !options.ssh) throw new CliError(2, 'INVALID_ARGUMENTS', 'Use connection add <name> --ssh <alias>.', false, { parameters: ["name", "--ssh"], reason: 'invalid-value' });
    if (Object.hasOwn(config.connections, selected)) throw new CliError(5, 'CONNECTION_EXISTS', 'Connection already exists.');
    if (options['ssh-config'] && !isAbsolute(options['ssh-config'])) throw new CliError(2, 'INVALID_ARGUMENTS', 'SSH config path must be absolute.', false, { parameters: ["--ssh-config"], reason: 'invalid-value' });
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
  catch { throw new CliError(2, 'INVALID_ARGUMENTS', 'Invalid SSH alias.', false, { parameters: ["--ssh"], reason: 'invalid-value' }); }
  const client = new CollaborationClient(transport);
  try {
    await client.connect(command==='thread count'?{threadCountOnly:true}:undefined);
    const directory = await client.servers();
    if (profile.instanceId && profile.instanceId !== directory.instanceId) throw new CliError(3, 'INSTANCE_MISMATCH', 'Instance identity changed.');
    if (adding) {
      if (profile.defaultServer) profile.defaultServer = selectServer(directory.servers, profile.defaultServer).serverId;
      config.connections[selected] = { ...profile, instanceId: directory.instanceId };
      if (options.default) config.defaultConnection = selected;
      await save(config);
      return { connection: selected, instanceId: directory.instanceId, actor: directory.actor };
    }
    if (args[0] === 'server' && args[1] === 'list' && args.length === 2) return directory;
    if (command === 'status' && options.server === undefined) return {
      connection: selected, selectionSource, instanceId: directory.instanceId,
      actor: directory.actor, servers: directory.servers, connectionState: directory.servers.some(s => s.connectionState === 'unavailable') ? 'unavailable' : directory.servers.every(s => s.connectionState === 'ready') ? 'ready' : 'unknown',
    };
    if (options['all-servers']) return await acrossServers(directory.servers, async server => {
      if (command === 'thread list') {
        const page = await client.discover(server.serverId, undefined, options['include-title']);
        return { ...page, conversations: page.conversations.map(row => withAttentionLink(row, profile)) };
      }
      const capability = options.field === 'text' ? 'publicTextSearch' : 'threadSearch';
      if (server.capabilities[capability] !== true) throw unsupported(directory.servers, server, command, capability);
      return options.field === 'text' ? await client.publicTextSearch(server.serverId,args[2]!) : await client.threadSearch(server.serverId,args[2]!);
    });
    const explicitServer = options.server === undefined ? undefined : selectServer(directory.servers, options.server).serverId;
    const needsReference = args[0] === 'interactions' || args[0] === 'queue'
      || args[0] === 'thread' && !['list','create','search','count'].includes(args[1]!) && !(args[1] === 'lookup' && args.length === 2);
    const canonicalRef = needsReference ? parseConversationRef(args[2] ?? '') : null;
    const server = selectServer(directory.servers, explicitServer ?? canonicalRef?.serverId ?? profile.defaultServer);
    const uriRef = needsReference ? reference(args[2], explicitServer ?? server.serverId) : null;
    const requireCapability = (capability: keyof typeof server.capabilities) => {
      if (server.capabilities[capability] !== true) throw unsupported(directory.servers,server,command,capability);
    };
    if (command === 'status') return { connection: selected, selectionSource, instanceId: directory.instanceId,
      actor: directory.actor, server, connectionState: server.connectionState };
    if (command === 'thread count') {
      const result = await client.threadCount(server.serverId);
      if (profile.instanceId && profile.instanceId !== result.instanceId) throw new CliError(3, 'INSTANCE_MISMATCH', 'Instance identity changed.');
      return result;
    }
    if (command === 'project list' || command === 'server models' || command === 'thread options') {
      const capability = command === 'project list' ? 'projectDiscovery' : command === 'server models' ? 'modelDiscovery' : 'executionOptions';
      requireCapability(capability);
      return command === 'project list' ? await client.projects(server.serverId,options.cursor)
        : command === 'server models' ? await client.models(server.serverId,options.cursor) : await client.options(uriRef!);
    }
    if (args[0] === 'interactions') {
      const capability=interactionSubmission ? 'interactionRespond' : 'interactions';
      requireCapability(capability);
      return interactionSubmission ? await client.respondInteraction(uriRef!,interactionSubmission)
        : await client.interactions(uriRef!,command==='interactions show'?args[3]:undefined,options.cursor);
    }
    if(command==='thread search'){if(options.field==='text'){requireCapability('publicTextSearch');return await client.publicTextSearch(server.serverId,args[2]!,options.cursor);}requireCapability('threadSearch');return await client.threadSearch(server.serverId,args[2]!,options.cursor);}
    if(command==='thread context'||command==='thread commands'){requireCapability(command==='thread context'?'contextUsage':'threadCommands');try{return command==='thread context'?await client.context(uriRef!):await client.commands(uriRef!);}catch(error){if(classify(error).code==='UNSUPPORTED_CAPABILITY')throw unsupported(directory.servers,server,command,command==='thread context'?'contextUsage':'threadCommands');throw error;}}
    if(command==='thread attachments'){requireCapability('messageAttachments');return await client.messageAttachments(uriRef!,{...(options.message===undefined?{}:{clientMessageId:options.message}),...(options.cursor===undefined?{}:{cursor:options.cursor})});}
    if (command === 'queue list') {
      requireCapability('queueRequests');
      return await client.queueRequests(uriRef!,options.cursor,options.limit === undefined ? undefined : Number(options.limit));
    }
    if(command==='thread defaults'){
      const cap=options['observe-only']?'threadDefaultsObserve':'threadDefaults';
      requireCapability(cap);
      const value=options['observe-only']?await client.observeThreadDefaults(uriRef!):await setThreadDefaults(client,uriRef!,defaultsBundle!);
      return {...value,uiLink:conversationUiLink(profile.webUrl,uriRef!)};
    }
    if (command==='thread stop' || command==='queue cancel') {
      const capability=command==='queue cancel'?'queueCancel':options['observe-only']?'stopObserve':'stop';
      requireCapability(capability);
      return command==='queue cancel' ? await cancelQueue(client,uriRef!,options.request!)
        : await stopThread(client,uriRef!,options['expected-turn']!,options['observe-only']);
    }
    if (args[0] !== 'thread') throw new CliError(2, 'INVALID_ARGUMENTS', 'Check --help.');
    if (createInput?.settings || sendInput?.settings) requireCapability('modelSettings');
    if (createInput) {
      if(options['permission-mode']) requireCapability('initialPermissionMode');
      requireCapability('create');
      const projectId = server.capabilities.projectDiscovery === true
        ? await resolveProject(options.project!, cursor => client.projects(server.serverId, cursor)) : options.project!;
      return await createConversation(client,{serverId:server.serverId,projectId,cwd:options.cwd!,...(options['permission-mode'] ? {initialOptions:{permissionMode:options['permission-mode'] as 'read-only'|'accept-edits'|'full'}} : {})},createInput,profile.webUrl);
    }
    if (args[1]==='lookup' && args.length===2) {
      const lookup=await client.lookupCreation(server.serverId,options.key!);
      return lookup.found ? {...lookup,operation:creationLink(lookup.operation,profile.webUrl),uiLink:conversationUiLink(profile.webUrl,lookup.operation.ref)} : {...lookup,uiLink:null};
    }
    if (args[1] === 'list' && args.length === 2) {
      if (options.project !== undefined || options.cwd !== undefined) requireCapability('discoverFilters');
      const result = await client.discover(server.serverId, options.cursor, options['include-title'], { projectId: options.project, cwd: options.cwd });
      return { ...result, conversations: result.conversations.map(row => withAttentionLink(row, profile)) };
    }
    if (target) {
      requireCapability('exactResult');
      return command === 'thread wait' ? await waitForResult(client,uriRef!,target,waitTimeout!,options.output) : await client.exactResult(uriRef!,target,true,options.cursor);
    }
    if (args[1] === 'show' && args.length === 3) {
      let configurationReceipt:import('@opencraft/appserver-protocol/collaboration').ConversationReceipt|null=null;
      const observation=async()=>{
        if(!options['include-turn-configuration'])return {};
        const target=resultTarget(options.delivery,options['delivery-key'],options.turn);
        if(server.capabilities.turnConfigurationObservation!==true)return {turnConfigurationObservation:unobservedTurnConfiguration(options.turn??null,'unsupported')};
        try { const observed=await client.turnConfigurationObservation(uriRef!,target);configurationReceipt=observed.receipt;return {turnConfigurationObservation:observed.turnConfigurationObservation}; }
        catch(error) { if(classify(error).code==='UNSUPPORTED_CAPABILITY')return {turnConfigurationObservation:unobservedTurnConfiguration(options.turn??null,'unsupported')};throw error; }
      };
      if (options.delivery !== undefined) return { ...await client.delivery(uriRef!, options.delivery),...await observation(), uiLink: conversationUiLink(profile.webUrl, uriRef!) };
      if (options['delivery-key'] !== undefined) {
        const found = await client.lookup(uriRef!, options['delivery-key']);
        const observed=await observation();
        const result=!found.found&&configurationReceipt?{found:true as const,receipt:configurationReceipt}:found;
        return { ...result,...observed, uiLink: conversationUiLink(profile.webUrl, result.found ? result.receipt.ref : null) };
      }
      if(options.turn!==undefined)return {ref:uriRef!,actualTurnSettings:null,...await observation(),uiLink:conversationUiLink(profile.webUrl,uriRef!)};
      return withAttentionLink(await client.metadata(uriRef!), profile);
    }
    if (args[1] === 'lookup') {
      const result = await client.lookup(uriRef!, options.key!);
      return { ...result, uiLink: conversationUiLink(profile.webUrl, result.found ? result.receipt.ref : null) };
    }
    if (args[1] === 'send' && sendInput) {
      requireCapability(sendInput.execution?.mode ?? 'queue');
      return await sendWithAttention(client, uriRef!, sendInput, { instanceId: directory.instanceId, actorId: directory.actor.id,
        recordsDirectory: join(dirname(configPath()), 'operations') }, profile);
    }
    if (args[1] === 'log' && args.length === 3) {
      requireCapability('boundedRead');
      if (options.tail !== undefined) {
        requireCapability('tailRead');
        return await client.tail(uriRef!, Number(options.tail));
      }
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
    else if ('version' in data && !argv.includes('--json')) process.stdout.write('opencraft ' + data.version + ' source ' + data.source + '\n');
    else process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, data }) + '\n');
  } catch (error) {
    const fault = classify(error);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: fault.code, message: fault.message, retryable: fault.retryable,
      ...(fault.details === undefined ? {} : { details: fault.details }) } }) + '\n');
    process.exitCode = fault.exitCode;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
