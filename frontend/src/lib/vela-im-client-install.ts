import release from "@/lib/generated/vela-im-client-release.json";

export const VELA_IM_CLIENT_RELEASE = release;

export function buildImClientInstallCommand(artifact = release): string {
  for (const checksum of [artifact.installerSha256, artifact.binarySha256]) {
    if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error("Invalid IM release checksum");
  }
  for (const url of [artifact.installerUrl, artifact.binaryUrl]) {
    if (!/^https:\/\/[A-Za-z0-9./_-]+$/.test(url)) throw new Error("Invalid IM release URL");
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$/.test(artifact.version)) throw new Error("Invalid IM release version");
  return [
    "set -eu",
    "umask 077",
    'vela_im_stage=$(mktemp -d)',
    'trap \'rm -rf "$vela_im_stage"\' EXIT HUP INT TERM',
    `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 --output "$vela_im_stage/install.sh" '${artifact.installerUrl}'`,
    `printf '%s  %s\\n' '${artifact.installerSha256}' "$vela_im_stage/install.sh" | sha256sum -c -`,
    `sh "$vela_im_stage/install.sh" --binary-url '${artifact.binaryUrl}' --sha256 '${artifact.binarySha256}' --version '${artifact.version}'`,
  ].join("\n");
}

export function didInstallImClient(result: { exitCode: number; output: string }): boolean {
  return result.exitCode === 0 && result.output.split(/\r?\n/).includes(`VELA_IM_CLIENT_INSTALLED ${release.version}`);
}

const jobRoot = '"$HOME/.local/share/lightvela/im-client/install-job"';

/** Existing Bot exec calls are short; the download must outlive their 30s limit. */
export function buildImClientInstallStartCommand(): string {
  const command = buildImClientInstallCommand();
  return [
    "set -eu", "umask 077",
    "command -v flock >/dev/null", "command -v nohup >/dev/null",
    `vela_im_job=${jobRoot}`,
    'mkdir -p "$vela_im_job"',
    'exec 9>"$vela_im_job/launch.lock"',
    'if ! flock -n 9; then echo VELA_IM_INSTALL_STARTED; exit 0; fi',
    'cat >"$vela_im_job/run.sh" <<\'VELA_IM_RUN\'',
    `vela_im_job=${jobRoot}`,
    'if (', command, '); then',
    '  printf "%s\\n" installed >"$vela_im_job/state.next"',
    'else', '  printf "%s\\n" failed >"$vela_im_job/state.next"', 'fi',
    'mv "$vela_im_job/state.next" "$vela_im_job/state"',
    'VELA_IM_RUN',
    'printf "%s\\n" installing >"$vela_im_job/state"',
    'nohup sh "$vela_im_job/run.sh" >"$vela_im_job/log" 2>&1 </dev/null &',
    'echo VELA_IM_INSTALL_STARTED',
  ].join("\n");
}

export const IM_CLIENT_INSTALL_STATUS_COMMAND = [
  `vela_im_job=${jobRoot}`,
  'if [ -r "$vela_im_job/state" ]; then cat "$vela_im_job/state"; else echo idle; fi',
].join("\n");
