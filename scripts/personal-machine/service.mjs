import { isAbsolute, join } from "node:path";

function assertSafeAbsolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.trim() !== value || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error("Invalid machine service path");
  }
  return value;
}

const escapeSystemdSpecifier = (value) => value.replace(/%/gu, "%%");
const escapeSystemdArgument = (value) =>
  `"${escapeSystemdSpecifier(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\$/gu, "$$")}"`;

export function machineServiceUnit(state, executable) {
  assertSafeAbsolutePath(state);
  assertSafeAbsolutePath(executable);
  return (
    "[Unit]\n" +
    "Description=OpenCraft personal machine\n" +
    "[Service]\n" +
    `WorkingDirectory=${escapeSystemdSpecifier(join(state, "runtime"))}\n` +
    `ExecStart=${[executable, join(state, "launcher.mjs"), "--state", state].map(escapeSystemdArgument).join(" ")}\n` +
    "Restart=on-failure\n" +
    "RestartSec=5\n" +
    "KillMode=mixed\n" +
    "TimeoutStopSec=60\n" +
    "[Install]\n" +
    "WantedBy=default.target\n"
  );
}

const escapePlistXml = (value) =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");

export function machineLaunchAgentLabel(id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/iu.test(id)) {
    throw new Error("Invalid machine identifier");
  }
  return `app.opencraft.machine.${id.toLowerCase()}`;
}

export function machineLaunchAgentPlist(id, state, executable) {
  const label = machineLaunchAgentLabel(id);
  assertSafeAbsolutePath(state);
  assertSafeAbsolutePath(executable);
  const args = [executable, join(state, "launcher.mjs"), "--state", state];
  const logPath = escapePlistXml(join(state, "daemon.log"));
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    "<dict>\n" +
    "  <key>Label</key>\n" +
    `  <string>${escapePlistXml(label)}</string>\n` +
    "  <key>ProgramArguments</key>\n" +
    "  <array>\n" +
    args.map((item) => `    <string>${escapePlistXml(item)}</string>\n`).join("") +
    "  </array>\n" +
    "  <key>WorkingDirectory</key>\n" +
    `  <string>${escapePlistXml(join(state, "runtime"))}</string>\n` +
    "  <key>RunAtLoad</key>\n" +
    "  <true/>\n" +
    "  <key>KeepAlive</key>\n" +
    "  <dict>\n" +
    "    <key>SuccessfulExit</key>\n" +
    "    <false/>\n" +
    "  </dict>\n" +
    "  <key>ThrottleInterval</key>\n" +
    "  <integer>5</integer>\n" +
    "  <key>StandardOutPath</key>\n" +
    `  <string>${logPath}</string>\n` +
    "  <key>StandardErrorPath</key>\n" +
    `  <string>${logPath}</string>\n` +
    "</dict>\n" +
    "</plist>\n"
  );
}
