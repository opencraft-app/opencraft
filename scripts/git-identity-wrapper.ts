import { spawn, execFile } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { queryGitIdentityBroker } from './git-identity-ipc.js';

const execute = promisify(execFile);
export function gitConfigParameter(key: string, value: string): string {
  return `'${`${key}=${value}`.replaceAll("'", "'\\''")}'`;
}
export function exactGitHost(url: string): string | null {
  try {
    if (/^[^/@:\s]+@[^/:\s]+:/u.test(url)) return url.slice(url.indexOf('@') + 1, url.indexOf(':'));
    const parsed = new URL(url);
    if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.port) return null;
    return parsed.hostname;
  } catch { return null; }
}
/** Convert only canonical Git SSH addresses; aliases and alternate SSH ports
 * cannot select a personal HTTPS identity implicitly. */
export function personalHttpsRemote(url: string, host: string): string | null {
  let path: string;
  const scp = /^git@([a-z0-9.-]+):(.+)$/u.exec(url);
  if (scp) { if (scp[1] !== host) return null; path = scp[2]!; }
  else {
    try {
      const value = new URL(url);
      if (value.protocol === 'https:' && value.hostname === host && !value.username && !value.password && !value.port) return url;
      if (value.protocol !== 'ssh:' || value.hostname !== host || value.username !== 'git' || value.password || value.port || value.search || value.hash) return null;
      path = value.pathname.slice(1);
    } catch { return null; }
  }
  if (!path || /[\s\\\0?#%]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return `https://${host}/${path}`;
}
export function parseGitInvocation(args: string[]) {
  const prefix: string[] = []; let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(arg)) {
      if (!args[i + 1]) throw new Error('Git identity: invalid Git option');
      prefix.push(arg, args[++i]!); continue;
    }
    if (/^(?:--git-dir=|--work-tree=|--namespace=|--config-env=|-c.)/u.test(arg) || ['--no-pager', '--paginate', '--bare', '--no-optional-locks', '--literal-pathspecs', '--no-literal-pathspecs', '--no-replace-objects'].includes(arg)) { prefix.push(arg); continue; }
    if (arg.startsWith('-')) throw new Error('Git identity: unsupported Git global option');
    break;
  }
  return { prefix, command: args[i] ?? '', tail: args.slice(i + 1) };
}
const writes = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'tag']);
const reads = new Set(['fetch', 'pull', 'ls-remote', 'clone']);
const network = new Set(['push', 'fetch', 'pull', 'ls-remote', 'clone', 'submodule']);
function networkRepositories(command: string, args: string[]): string[] {
  const valued = new Set(['--upload-pack', '--exec', '--receive-pack', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--negotiation-tip', '--server-option', '--filter', '--refmap', '--jobs', '-j', '-o', '--push-option', '--sort', '--exclude', '--template', '--reference', '--reference-if-able', '--origin', '--branch', '-b', '--separate-git-dir', '--config', '-c']);
  const repositories: string[] = []; let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg.startsWith('--repo=')) return [arg.slice(7)];
    if (!positional && arg === '--repo') return args[i + 1] ? [args[i + 1]!] : [];
    if (!positional && valued.has(arg)) { i++; continue; }
    if (!positional && arg.startsWith('-')) continue;
    repositories.push(arg);
    if (!(command === 'fetch' && args.includes('--multiple'))) break;
  }
  return repositories;
}
function conflicts(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const config = ['-c', '--config', '--config-env'].includes(arg) ? args[++i] ?? ''
      : arg.startsWith('-c') ? arg.slice(2) : /^--config(?:-env)?=/u.test(arg) ? arg.slice(arg.indexOf('=') + 1) : '';
    if (/^(?:credential\.|http\.|gpg\.|user\.|url\.|protocol\.|core\.(?:askpass|sshcommand))/iu.test(config)) return true;
  }
  return false;
}
function withoutTrace(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...base };
  for (const key of Object.keys(result)) if (key === 'GIT_CURL_VERBOSE' || key === 'GIT_TRACE' || key.startsWith('GIT_TRACE_') || key.startsWith('GIT_TRACE2')) delete result[key];
  return result;
}
async function privateGitHome(env: NodeJS.ProcessEnv): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-git-home-')); await chmod(directory, 0o700);
  try {
    const originalHome = process.env.HOME || homedir();
    if (process.env.GIT_CONFIG_GLOBAL === undefined) {
      const quote = (path: string) => {
        if (/[\r\n\0]/u.test(path)) throw new Error('Git global configuration path unavailable');
        return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
      };
      const paths = [join(process.env.XDG_CONFIG_HOME || join(originalHome, '.config'), 'git/config'), join(originalHome, '.gitconfig')];
      const projection = join(directory, 'global.config');
      await writeFile(projection, '[include]\n' + paths.map(path => `\tpath = ${quote(path)}\n`).join(''), { mode: 0o600 });
      env.GIT_CONFIG_GLOBAL = projection;
    } else if (process.env.GIT_CONFIG_GLOBAL.startsWith('~/')) env.GIT_CONFIG_GLOBAL = join(originalHome, process.env.GIT_CONFIG_GLOBAL.slice(2));
    // libcurl can read netrc without asking Git's credential helper. Only this
    // configured command gets an empty HOME; original global config stays read-only.
    env.HOME = directory; env.NETRC = join(directory, '.netrc');
    return () => rm(directory, { recursive: true, force: true });
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
const preserveAuthor = (command: string, tail: string[]) => ['rebase', 'cherry-pick', 'am'].includes(command) || (command === 'commit' && tail.some(arg => ['--amend', '-c', '-C', '--reuse-message', '--reedit-message'].includes(arg) || /^--(?:reuse|reedit)-message=/u.test(arg))) || (command === 'pull' && tail.some(a => a.startsWith('--rebase')));
async function retry(socket: string, request: unknown) {
  let lastStatus = 'unavailable';
  for (const delay of [0, 100, 300, 700]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { const answer = await queryGitIdentityBroker(socket, request); lastStatus = answer.status; if (!['unavailable', 'expired'].includes(answer.status)) return answer; }
    catch { /* Retry lookup only; never replay Git. */ }
  }
  throw new Error(`Git identity ${lastStatus === 'expired' ? 'execution lease expired' : 'broker unavailable'}; refusing server-account fallback`);
}
async function credentialHelper(socket: string, sessionId: string, action: string) {
  if (action !== 'get') return 0; // Never persist Git's store/erase messages.
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 16_384) return 1; }
  const fields: Record<string, string> = {};
  for (const line of input.split('\n')) {
    if (!line) continue; const at = line.indexOf('=');
    if (at < 1 || fields[line.slice(0, at)] !== undefined) { process.stdout.write('quit=true\n\n'); return 1; }
    fields[line.slice(0, at)] = line.slice(at + 1);
  }
  const result = await retry(socket, { op: 'credential', sessionId, protocol: fields.protocol, host: fields.host });
  if (result.status !== 'configured' || typeof result.username !== 'string' || typeof result.password !== 'string'
    || /[\r\n\0]/u.test(result.username + result.password) || (fields.username && fields.username !== result.username)) {
    process.stdout.write('quit=true\n\n'); return 1;
  }
  process.stdout.write(`username=${result.username}\npassword=${result.password}\n\n`); return 0;
}

export async function runManagedGit(args = process.argv.slice(2)): Promise<number> {
  const socket = process.env.OPENCRAFT_GIT_BROKER_SOCKET;
  if (args[0] === '--opencraft-credential-helper') {
    if (!socket || !process.env.OPENCRAFT_GIT_COMMAND_SESSION) throw new Error('Git credential command expired');
    return credentialHelper(socket, process.env.OPENCRAFT_GIT_COMMAND_SESSION, args[1] ?? '');
  }
  const native = process.env.OPENCRAFT_GIT_NATIVE;
  if (!native || !isAbsolute(native) || await realpath(native) === await realpath(process.argv[1]!)) throw new Error('Git identity: native Git path is unavailable');
  const run = async (env = process.env) => new Promise<number>((resolve, reject) => {
    const child = spawn(native, args, { env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  const threadId = process.env.OPENCRAFT_THREAD_ID || process.env.CODEX_THREAD_ID;
  // A regular administrator shell is outside this managed execution domain.
  if (!threadId && process.env.OPENCRAFT_GIT_MANAGED !== '1') return run();
  if (['--version', '-v', '--help', '-h'].includes(args[0] ?? '')) return run();
  const invocation = parseGitInvocation(args), { prefix, command, tail } = invocation;
  if (command === 'ls-remote' && tail.includes('--get-url')) return run();
  let isAlias = false;
  if (!command || (!writes.has(command) && !network.has(command))) {
    const alias = command ? await execute(native, [...prefix, 'config', '--get', `alias.${command}`]).then(r => r.stdout.trim()).catch(() => '') : '';
    if (!alias) return run();
    isAlias = true;
  }
  if (!threadId) throw new Error('Git execution context unavailable; refusing server-account fallback');
  if (!socket) throw new Error('Git identity broker unavailable; refusing server-account fallback');
  const queryEnv = withoutTrace(process.env);
  const queryGit = async (...query: string[]) => execute(native, [...prefix, ...query], { maxBuffer: 262_144, env: queryEnv }).then(r => r.stdout.trim());
  const urls = new Set<string>(), rawUrls = new Set<string>();
  const remotes = (await queryGit('remote').catch(() => '')).split('\n').filter(Boolean);
  const branch = await queryGit('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
  const pullRebase = command === 'pull' && !tail.includes('--no-rebase') && (
    tail.some(arg => arg.startsWith('--rebase')) || /^(true|merges|interactive)$/u.test((branch ? await queryGit('config', '--get', `branch.${branch}.rebase`).catch(() => '') : '')
      || await queryGit('config', '--get', 'pull.rebase').catch(() => '')));
  const pushProfile = command === 'push' || !network.has(command);
  const preferred = (pushProfile ? (branch ? await queryGit('config', '--get', `branch.${branch}.pushRemote`).catch(() => '') : '')
    || await queryGit('config', '--get', 'remote.pushDefault').catch(() => '') : '')
    || (branch ? await queryGit('config', '--get', `branch.${branch}.remote`).catch(() => '') : '') || (remotes.includes('origin') ? 'origin' : '');
  const explicit = network.has(command) && command !== 'submodule' ? networkRepositories(command, tail) : [];
  const targets = tail.includes('--all') ? remotes : explicit.length ? explicit : preferred ? [preferred] : remotes;
  for (const target of targets) {
    let effective: string;
    if (remotes.includes(target)) {
      effective = await queryGit('remote', 'get-url', '--all', ...(pushProfile ? ['--push'] : []), target).catch(() => '');
      const pushUrls = pushProfile ? await queryGit('config', '--get-all', `remote.${target}.pushurl`).catch(() => '') : '';
      for (const url of (pushUrls || await queryGit('config', '--get-all', `remote.${target}.url`).catch(() => '')).split('\n')) if (url) rawUrls.add(url);
    }
    else {
      rawUrls.add(target);
      // Native ls-remote --get-url expands normal insteadOf without networking.
      // For an explicit push URL, Git gives the longest pushInsteadOf match
      // precedence and does not apply another normal rewrite to its result.
      let pushRewrite: { prefix: string; base: string } | undefined;
      if (pushProfile) for (const item of (await queryGit('config', '--null', '--get-regexp', '^url\\..*\\.pushinsteadof$').catch(() => '')).split('\0')) {
        const separator = item.indexOf('\n'); if (separator < 0) continue;
        const key = item.slice(0, separator), value = item.slice(separator + 1);
        if (value && target.startsWith(value) && (!pushRewrite || value.length > pushRewrite.prefix.length)) pushRewrite = { prefix: value, base: key.slice(4, -'.pushinsteadof'.length) };
      }
      effective = pushRewrite ? pushRewrite.base + target.slice(pushRewrite.prefix.length) : await queryGit('ls-remote', '--get-url', target).catch(() => '');
    }
    for (const url of effective.split('\n')) if (url) urls.add(url);
  }
  // Final helper responses still authorize protocol+host; URL hints only select the local identity profile.
  const hosts = new Set([...urls].map(exactGitHost));
  const supported = (process.env.OPENCRAFT_GIT_HOSTS ?? 'github.com').split(',').filter(Boolean);
  const managedHosts = [...hosts].filter((host): host is string => host !== null && supported.includes(host));
  // No remote/profile means no safe identity guess. Confirm unconfigured before retaining legacy behavior.
  const cloneConflict = command === 'clone' && conflicts(tail);
  const candidates = command === 'submodule' || cloneConflict || !managedHosts.length ? supported : managedHosts;
  const bindings = await Promise.all(candidates.map(async host => ({ host, reply: await retry(socket, { op: 'open', threadId, host }) })));
  const sessions = bindings.filter(binding => binding.reply.status === 'configured');
  let releaseHome: (() => Promise<void>) | undefined;
  try {
    if (bindings.some(binding => !['configured', 'unconfigured'].includes(binding.reply.status))) throw new Error('Git execution lease expired or unavailable; refusing server-account fallback');
    if (!sessions.length) return run();
    if (command === 'submodule') throw new Error('Git identity: run network commands in the explicit submodule repository');
    if (isAlias) throw new Error('Git identity: use the explicit Git command instead of an alias in managed execution');
    if (hosts.size !== 1 || managedHosts.length !== 1 || sessions.length !== 1) throw new Error('Git identity profile is ambiguous; select one managed HTTPS remote');
    const { host, reply } = sessions[0]!;
    const httpsUrls = new Map([...urls].map(url => [url, personalHttpsRemote(url, host)]));
    if (network.has(command) && [...httpsUrls].some(([url, https]) => !https || (url !== https && !rawUrls.has(url))))
      throw new Error('Personal Git credentials require a matching HTTPS remote or canonical SSH remote without conflicting URL rewrites');
    if (conflicts(prefix) || cloneConflict) throw new Error('Git identity: conflicting command authentication configuration');
    if (network.has(command)) {
      for (const url of httpsUrls.values()) for (const key of ['http.sslCert', 'http.sslKey']) {
        if (!url) continue;
        if (await queryGit('config', '--get-urlmatch', key, url).catch(() => undefined) !== undefined)
          throw new Error('Git identity: conflicting client-certificate authentication');
      }
      if (process.env.GIT_SSL_CERT || process.env.GIT_SSL_KEY) throw new Error('Git identity: conflicting client-certificate authentication');
    }
    // This is an explicit deployment policy, never a retry after personal Git fails.
    const serverRead = reads.has(command) && (process.env.OPENCRAFT_GIT_SERVER_READ_HOSTS ?? '').split(',').includes(host);
    const env: NodeJS.ProcessEnv = { ...withoutTrace(process.env), OPENCRAFT_GIT_COMMAND_SESSION: reply.sessionId,
      GIT_COMMITTER_NAME: reply.identity.name, GIT_COMMITTER_EMAIL: reply.identity.email, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' };
    env.GIT_TRACE_REDACT = '1';
    if (!serverRead) {
      releaseHome = await privateGitHome(env);
      env.GIT_SSH_COMMAND = '/bin/false'; env.GIT_SSH = '/bin/false';
    }
    delete env.GIT_SSL_CERT; delete env.GIT_SSL_KEY; delete env.GIT_SSL_CERT_PASSWORD_PROTECTED;
    if (writes.has(command) || command === 'pull') {
      if (!preserveAuthor(command, tail) && !pullRebase) { env.GIT_AUTHOR_NAME = reply.identity.name; env.GIT_AUTHOR_EMAIL = reply.identity.email; }
    }
    const parameters: Array<[string, string]> = [];
    const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    if (serverRead) {
      for (const [url, https] of httpsUrls) {
        const ssh = `git@${host}:${new URL(https!).pathname.slice(1)}`;
        if (personalHttpsRemote(ssh, host) !== https) throw new Error('Git identity: server read requires a canonical repository path');
        if (url === https) parameters.push([`url.${ssh}.insteadOf`, url]);
      }
    } else {
      parameters.push(['credential.helper', ''], ['credential.username', ''], ['credential.useHttpPath', 'true'], ['http.extraHeader', ''], ['http.cookieFile', ''], ['http.saveCookies', 'false'], ['http.emptyAuth', 'false'], ['http.followRedirects', 'false'], ['protocol.ssh.allow', 'never']);
      for (const [url, https] of httpsUrls) if (https && url !== https && rawUrls.has(url))
        parameters.push([`url.${https}.insteadOf`, url]);
      // URL-specific headers/cookies can override the global reset; clear every inherited scope.
      for (const key of (await queryGit('config', '--name-only', '--get-regexp', '^(http\\..*\\.(extraheader|cookiefile|emptyauth)|credential\\..*\\.username)$').catch(() => '')).split('\n').filter(Boolean)) parameters.push([key, '']);
      parameters.push(['credential.helper', `!${shellQuote(process.execPath)} ${shellQuote(resolve(process.argv[1]!))} --opencraft-credential-helper`]);
    }
    if (reply.signing) {
      let signingProgram = 'ssh-keygen';
      if (serverRead) {
        // Pull can create a personal signed merge while SSH transport retains
        // the server's original agent. The broker removes this command directory.
        signingProgram = join(dirname(reply.signing.socket), 'git-signing-command');
        await writeFile(signingProgram, `#!/bin/sh\nSSH_AUTH_SOCK=${shellQuote(reply.signing.socket)} exec ssh-keygen "$@"\n`, { mode: 0o700, flag: 'wx' });
      } else env.SSH_AUTH_SOCK = reply.signing.socket;
      parameters.push(['gpg.format', 'ssh'], ['gpg.ssh.program', signingProgram], ['user.signingkey', `key::${reply.signing.publicKey}`], ['commit.gpgsign', 'true'], ['tag.gpgsign', 'true']);
    } else parameters.push(['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']);
    env.GIT_CONFIG_PARAMETERS = `${process.env.GIT_CONFIG_PARAMETERS ?? ''} ${parameters.map(([key, value]) => gitConfigParameter(key, value)).join(' ')}`.trim();
    return await run(env);
  } finally {
    await releaseHome?.();
    for (const session of sessions) await queryGitIdentityBroker(socket, { op: 'close', sessionId: session.reply.sessionId }).catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runManagedGit().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Git identity unavailable'}\n`); process.exitCode = 128; });
}
