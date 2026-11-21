import { isAbsolute } from 'node:path';

/** Installation constants only. Employee identity remains in the trusted execution lease. */
export function managedGitEnvironment(base: NodeJS.ProcessEnv, paths: {
  binDirectory: string; nativeGit: string; brokerSocket: string; hosts: readonly string[];
  bashEnvironment?: string;
}): NodeJS.ProcessEnv {
  if (![paths.binDirectory, paths.nativeGit, paths.brokerSocket, ...(paths.bashEnvironment ? [paths.bashEnvironment] : [])].every(path => isAbsolute(path) && !/[\0\r\n:]/u.test(path))
    || !paths.hosts.length || paths.hosts.some(host => !/^[a-z0-9.-]{1,253}$/u.test(host))) throw new Error('Invalid managed Git environment');
  const env = { ...base, PATH: [paths.binDirectory, ...(base.PATH ?? '/usr/bin:/bin').split(':').filter(path => path !== paths.binDirectory)].join(':'),
    OPENCRAFT_GIT_MANAGED: '1', OPENCRAFT_GIT_BIN: paths.binDirectory, OPENCRAFT_GIT_NATIVE: paths.nativeGit, OPENCRAFT_GIT_BROKER_SOCKET: paths.brokerSocket, OPENCRAFT_GIT_HOSTS: paths.hosts.join(',') };
  if (paths.bashEnvironment) {
    return { ...env, BASH_ENV: paths.bashEnvironment,
      ...(base.BASH_ENV && base.BASH_ENV !== paths.bashEnvironment ? { OPENCRAFT_GIT_PREVIOUS_BASH_ENV: base.BASH_ENV } : {}) };
  }
  return env;
}
