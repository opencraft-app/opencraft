const EXECUTABLE_NAME = "[A-Za-z0-9_+./-]+";
const COMMAND_V_PROBE = new RegExp(
  `^command\\s+-v(?:\\s+--)?\\s+(?:'(${EXECUTABLE_NAME})'|"(${EXECUTABLE_NAME})"|(${EXECUTABLE_NAME}))\\s*$`,
);

/**
 * Parse the single executable operand from a POSIX `command -v` probe.
 *
 * DSH deliberately emits `command -v -- 'bash'`; accepting the optional
 * option terminator and a quoted literal keeps the vSSH capability probe
 * compatible without turning this interception point into a shell parser.
 */
export function executableFromCommandVProbe(command: unknown): string | null {
  const match = COMMAND_V_PROBE.exec(String(command ?? ""));
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}
