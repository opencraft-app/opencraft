// Live desktop command recipes; never evaluated as local shell commands.
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const invoke = 'exec /bin/sh -c "$CODEX_REMOTE_PAYLOAD"';
const home = 'CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export CODEX_HOME';
const desktopWrapper = [
  'if [ -z "$SHELL" ] || [ ! -x "$SHELL" ]; then echo "Codex remote SSH requires SHELL to point to an executable login shell" >&2; exit 127; fi;',
  'CODEX_REMOTE_PAYLOAD="$1"; export CODEX_REMOTE_PAYLOAD;',
  'case "${SHELL##*/}" in',
  `csh|tcsh) exec "$SHELL" -i -c ${shellQuote(["set loginsh=1", "if ( -r /etc/csh.login ) source /etc/csh.login", "if ( -r ~/.login ) source ~/.login", invoke].join("; "))} ;;`,
  `nu) exec "$SHELL" -l -i -c ${shellQuote("exec /bin/sh -c $env.CODEX_REMOTE_PAYLOAD")} ;;`,
  `fish|xonsh) exec "$SHELL" -l -i -c ${shellQuote(invoke)} ;;`,
  `*) exec "$SHELL" -l -i -c ${shellQuote(`${home}; ${invoke}`)} ;;`,
  "esac"
].join(" ");
const desktopPath = 'PATH="${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"; export PATH';
const directory = '"${CODEX_HOME:-$HOME/.codex}/app-server-control"';
const log = '"${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server.log"';
const agent = '"${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock"';
const forward = `if [ -S "\${SSH_AUTH_SOCK:-}" ]; then ln -sfn -- "$SSH_AUTH_SOCK" ${agent}; elif [ ! -S ${agent} ]; then rm -f -- ${agent}; fi`;
const desktopActions = {
  locate: "if command -v codex >/dev/null 2>&1; then exit 0; fi; exit 86",
  version: "codex --version",
  ensure: `if [ "${"${CODEX_SSH_SKIP_APP_SERVER_BOOT:-}"}" = "true" ]; then exit 0; fi; (umask 077; mkdir -p -- ${directory} && (pkill -9 -U "$(id -u)" -f ${shellQuote("codex.*[d]esktop-ssh-websocket-v0.sock")} || true) && ${forward} && : >${log}) && SSH_AUTH_SOCK=${agent} nohup codex -c features.code_mode_host=true app-server --listen ${shellQuote("unix://")} >${log} 2>&1 &`,
  proxy: `${forward} && exec codex app-server proxy`
};
const desktopCurrentEnsure = desktopActions.ensure.replace("'unix://'", "unix://").replace(") && SSH_AUTH_SOCK=", ") && { SSH_AUTH_SOCK=").replace("unix:// >", "unix:// </dev/null >") + " }";

function codexCommandShape(command) {
  const prefix = `sh -c ${shellQuote(desktopWrapper)} sh `;
  if (command.startsWith(prefix)) command = command.slice(prefix.length).slice(1, -1).replaceAll("'\\''", "'");
  const allowed = /* @__PURE__ */ new Set(["sh", "bash", "-c", "-lc", "CODEX_REMOTE_PAYLOAD", "export", "exec", "SHELL", "/bin/sh", "printf", "codex", "app-server", "proxy", "--sock", "command", "-v", "--version", "CODEX_HOME", "CODEX_SSH_SKIP_APP_SERVER_BOOT", "CODEX_INSTALL_DIR", "HOME", "PATH", "SSH_AUTH_SOCK", "features.code_mode_host", "true", "false", "if", "then", "fi", "exit", "umask", "mkdir", "pkill", "id", "nohup", "ln", "rm", "elif", "--listen", "unix://", "-p", "-9", "-U", "-u", "-f", "-S", "-sfn", "077", "/app-server-control", "/app-server-control/app-server.log", "/app-server-control/forwarded-ssh-agent.sock", "86", "0", "2", "x", "1"]);
  return command.slice(0, 4096).replace(/(?:\\[0-7]{3})+/gu, "<octal>").replace(/[A-Za-z0-9_./:+-]+/gu, (token) => allowed.has(token) ? token : "<value>").replace(/[^\x20-\x7e]/gu, "?").slice(0, 1024);
}
function parseCodexProxyCommand(command) {
  if (command.length > 4096) return null;
  if (command === "codex app-server proxy") return { kind: "proxy", sentinel: Buffer.alloc(0) };
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = 'CODEX_REMOTE_PAYLOAD="$1"; export CODEX_REMOTE_PAYLOAD; exec "${SHELL:-/bin/sh}" -lc "$CODEX_REMOTE_PAYLOAD"';
  const prefix = `sh -c ${quote(wrapper)} sh `;
  const desktopPrefix = `sh -c ${shellQuote(desktopWrapper)} sh `;
  if (command.startsWith(desktopPrefix)) {
    const argument = command.slice(desktopPrefix.length);
    if (!argument.startsWith("'") || !argument.endsWith("'")) return null;
    const payload2 = argument.slice(1, -1).replaceAll("'\\''", "'");
    if (shellQuote(payload2) !== argument) return null;
    const marker = /^printf '%b' '((?:\\[0-3][0-7]{2}){8})'; /u.exec(payload2);
    if (!marker) return null;
    const rest = payload2.slice(marker[0].length);
    for (const kind of ["locate", "version", "ensure", "proxy"]) {
      const action = desktopActions[kind];
      const nativeQuoted = kind === "ensure" ? action.replace("'unix://'", "unix://") : action;
      if (rest === `${desktopPath}; ${action}` || rest === `${desktopPath}; ${nativeQuoted}` || kind === "ensure" && rest === `${desktopPath}; ${desktopCurrentEnsure}`) return { kind, sentinel: Buffer.from(marker[1].split("\\").slice(1).map((value) => Number.parseInt(value, 8))) };
    }
    return null;
  }
  let payload;
  if (command.startsWith(prefix)) {
    const argument = command.slice(prefix.length);
    if (!argument.startsWith("'") || !argument.endsWith("'")) return null;
    payload = argument.slice(1, -1).replaceAll("'\\''", "'");
    if (quote(payload) !== argument) return null;
  } else {
    const match2 = /^sh -c 'CODEX_REMOTE_PAYLOAD=(?:"\$1"|\\"\$1\\"); (.+)'(?: sh x)?$/u.exec(command);
    if (!match2) return null;
    payload = match2[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  const match = /^printf (?:'((?:\\[0-3][0-7]{2}){8})'|"((?:\\[0-3][0-7]{2}){8})"); (?:exec )?codex app-server proxy$/u.exec(payload);
  if (!match) return null;
  const octal = match[1] ?? match[2];
  return { kind: "proxy", sentinel: Buffer.from(octal.split("\\").slice(1).map((value) => Number.parseInt(value, 8))) };
}


export { parseCodexProxyCommand, codexCommandShape };
