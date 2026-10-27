import { isAbsolute, join } from 'node:path';
import { managedGitEnvironment } from './git-identity-environment.js';

/** Render reviewable files; service installation/restarts remain the deployment owner's action. */
export function renderGitIdentityInstallation(input: {
  installationDirectory: string; runtimeDirectory: string; node: string; nativeGit: string;
  brokerSocket: string; hosts: readonly string[]; basePath: string;
}) {
  if (![input.installationDirectory, input.runtimeDirectory, input.node].every(path => isAbsolute(path) && !/[\r\n\0]/u.test(path))) throw new Error('Invalid Git installation path');
  const bin = join(input.installationDirectory, 'bin'), bashEnvironment = join(input.runtimeDirectory, 'git-identity-shell-env.sh');
  const env = managedGitEnvironment({ PATH: input.basePath }, { binDirectory: bin, nativeGit: input.nativeGit, brokerSocket: input.brokerSocket, hosts: input.hosts, bashEnvironment });
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const systemdQuote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return {
    launcher: `#!/bin/sh\nexec ${shellQuote(input.node)} ${shellQuote(join(input.runtimeDirectory, 'git-identity-wrapper.mjs'))} "$@"\n`,
    environmentFile: Object.entries(env).map(([key, value]) => `${key}=${systemdQuote(value!)}`).join('\n') + '\n',
    environment: env,
  };
}
