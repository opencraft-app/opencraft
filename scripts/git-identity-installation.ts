import { isAbsolute, join } from 'node:path';
import { managedGitEnvironment } from './git-identity-environment.js';

/** Render reviewable files; service installation/restarts remain the deployment owner's action. */
export function renderGitIdentityInstallation(input: {
  installationDirectory: string; runtimeDirectory: string; node: string; nativeGit: string;
  brokerSocket: string; hosts: readonly string[]; basePath: string; serverReadHosts?: readonly string[]; personalSshPushHosts?: readonly string[];
}) {
  if (![input.installationDirectory, input.runtimeDirectory, input.node].every(path => isAbsolute(path) && !/[\r\n\0]/u.test(path))) throw new Error('Invalid Git installation path');
  if (input.serverReadHosts?.some(host => !/^[a-z0-9.-]{1,253}$/u.test(host) || !input.hosts.includes(host))) throw new Error('Invalid server Git read host');
  if (input.personalSshPushHosts?.some(host => !/^[a-z0-9.-]{1,253}$/u.test(host) || !input.hosts.includes(host))) throw new Error('Invalid personal SSH push host');
  const bin = join(input.installationDirectory, 'bin'), bashEnvironment = join(input.runtimeDirectory, 'git-identity-shell-env.sh');
  const env = managedGitEnvironment({ PATH: input.basePath }, { binDirectory: bin, nativeGit: input.nativeGit, brokerSocket: input.brokerSocket, hosts: input.hosts, bashEnvironment });
  if (input.serverReadHosts !== undefined) env.OPENCRAFT_GIT_SERVER_READ_HOSTS = input.serverReadHosts.join(',');
  if (input.personalSshPushHosts !== undefined) env.OPENCRAFT_GIT_PERSONAL_SSH_PUSH_HOSTS = input.personalSshPushHosts.join(',');
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const systemdQuote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return {
    launcher: `#!/bin/sh\n${input.serverReadHosts === undefined ? '' : `export OPENCRAFT_GIT_SERVER_READ_HOSTS=${shellQuote(input.serverReadHosts.join(','))}\n`}${input.personalSshPushHosts === undefined ? '' : `export OPENCRAFT_GIT_PERSONAL_SSH_PUSH_HOSTS=${shellQuote(input.personalSshPushHosts.join(','))}\n`}exec ${shellQuote(input.node)} ${shellQuote(join(input.runtimeDirectory, 'git-identity-wrapper.mjs'))} "$@"\n`,
    environmentFile: Object.entries(env).map(([key, value]) => `${key}=${systemdQuote(value!)}`).join('\n') + '\n',
    environment: env,
  };
}
