declare const __OPENCRAFT_CLI_VERSION__: string;
declare const __OPENCRAFT_CLI_SOURCE__: string;
export function cliVersion() {
  return {
    version: typeof __OPENCRAFT_CLI_VERSION__ === 'string' ? __OPENCRAFT_CLI_VERSION__ : '0.1.0',
    source: typeof __OPENCRAFT_CLI_SOURCE__ === 'string' ? __OPENCRAFT_CLI_SOURCE__ : 'unknown (unbundled source)',
  };
}
